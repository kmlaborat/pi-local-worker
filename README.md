# pi-local-worker

Delegate coding tasks from a pi Architect agent to an independent local Worker
agent, and get back a complete package of deterministic evidence about what
actually happened.

The Worker runs in its own pi `AgentSession`. It cannot see the Architect's
conversation, so every task must be self-contained. What comes back is not a
self-reported "done" — it is the observed workspace state, the result of
machine-checkable completion conditions, a policy decision over both, and the
lifecycle action that follows.

## What it does

- **Isolated execution.** Each task runs in a fresh `AgentSession` with its own
  resource loading. No conversation leakage in either direction.
- **Work boundary.** Read-only task types have write-capable tools blocked
  *before* they execute. Unknown tools fail closed.
- **Watchdog.** Detects apparently stalled LLM generation without mistaking
  active tool execution for a stall.
- **Steering.** A single `.` wake-up probe, budgeted and rate-limited, as the
  only permitted intervention.
- **Timeout, abort, liveness.** A bounded overall deadline with a cooperative
  drain, distinct from the watchdog and from explicit cancellation.
- **Workspace evidence.** Deterministic before/after Git observation, produced
  independently of the Worker's own report. Read-only: never mutates the repo.
- **Completion verification.** Tri-state checking of explicit requirements
  against that evidence.
- **Gate and Orchestrator.** A pure policy layer over the evidence, then a pure
  mapping from decision to lifecycle action.

## Architecture

```text
Architect
    │  TaskSpec
    ▼
Worker
    │
    ├── Execution
    ├── Workspace Evidence
    └── Verification
            │
            ▼
          Gate
            │
            ▼
      Orchestrator
            │
            │  OrchestrationDecision
            ▼
        Architect
```

Each layer answers exactly one question:

| Layer | Question it answers | Role |
|---|---|---|
| Worker | How did the execution terminate? | execute |
| Evidence | What happened in the workspace? | observe |
| Verification | Is there evidence the required conditions were met? | establish |
| Gate | How should that result be treated under policy? | decide |
| Orchestrator | What lifecycle action follows? | select |
| Architect | What does this mean, and what next? | judge |

The layers are deliberately not merged into a single success detector. Merging
any adjacent pair produces a component that both observes and judges, or both
judges and acts — which is the failure mode this design exists to prevent.

## Installation

Install as a pi package from Git:

```bash
pi install git:github.com/kmlaborat/pi-local-worker
```

Pin a ref if you need reproducibility:

```bash
pi install git:github.com/kmlaborat/pi-local-worker@v0.1.0
```

The `https://` and `git:https://` forms resolve to the same package:

```bash
pi install https://github.com/kmlaborat/pi-local-worker
pi install git:https://github.com/kmlaborat/pi-local-worker
```

Pi runs `npm install` in the cloned package, so no manual build step is
required. The extension entrypoint is declared in `package.json` under
`pi.extensions` and loads `src/index.ts` directly.

### Requirements

- **pi** — developed and verified against `@earendil-works/pi-coding-agent`
  0.85.1. No `engines` constraint is declared in `package.json`.
- **Node.js** — developed against Node 24; `@types/node` targets 22.19. The
  extension is loaded by pi's TypeScript-aware module loader, so no build step
  is needed on any recent Node.
- **git** — a working `git` binary is required. Workspace evidence is Git-based;
  without it, evidence is reported `unavailable` and workspace-dependent
  checks become `unverifiable`.

## Usage

The extension registers one tool: **`worker_run`**.

It blocks until the Worker reaches its settled state, then returns a JSON
result. Only one Worker can run at a time; a second concurrent call is
rejected rather than queued.

### TaskSpec

Everything the Worker knows comes from the TaskSpec.

| Field | Required | Meaning |
|---|---|---|
| `taskId` | yes | Stable identifier you choose. |
| `goal` | yes | What the Worker must accomplish. |
| `scope` | yes | Files, directories or areas the Worker may touch. |
| `workType` | yes | `investigate`, `review`, `verify`, `implement`, `refactor`, or `test`. |
| `completionCriteria` | yes | Human-readable conditions. **Context for the Worker; never machine-checked.** |
| `completionChecks` | no | Structured, machine-checkable requirements. The only authoritative verification input. |
| `relevantSpec` | no | References to specs, docs, or issues. |
| `preconditions` | no | Conditions that must already hold. |
| `testRequirements` | no | Required testing approach. |
| `implementationConstraints` | no | Restrictions on the implementation. |
| `forbiddenChanges` | no | Changes the Worker must not make. |
| `expectedReport` | no | What the Worker should report back. |

`workType` drives the work boundary. `investigate`, `review` and `verify` are
read-only: write-capable tools are blocked, and an implicit `no-changes`
requirement applies unless you supply an explicit workspace requirement.

### completionChecks

Five closed requirement kinds. There is no expression language.

```json
{ "id": "touched", "kind": "changed-files", "paths": ["src/a.ts"], "mode": "exact" }
{ "id": "covers",  "kind": "changed-files", "paths": ["src/a.ts"], "mode": "includes" }
{ "id": "hands-off", "kind": "forbidden-files", "paths": ["src/locked.ts"] }
{ "id": "clean", "kind": "no-changes" }
{ "id": "tests", "kind": "test", "argv": ["npm", "test"] }
```

All workspace kinds compare against the **Worker-induced** change set, not the
whole repository diff, so pre-existing dirt cannot skew the result.

`argv` is an argument vector, not a shell string. No shell is involved, so
`&&`, `|` and backticks are inert literal arguments.

### Example

```json
{
  "taskId": "fix-parser-overflow",
  "goal": "Fix the integer overflow in parseDuration for inputs over 2^31ms",
  "scope": ["src/parser.ts", "test/parser.test.ts"],
  "workType": "implement",
  "completionCriteria": [
    "parseDuration no longer overflows on large inputs",
    "a regression test covers the boundary"
  ],
  "completionChecks": [
    { "id": "scope", "kind": "changed-files", "paths": ["src/parser.ts", "test/parser.test.ts"], "mode": "exact" },
    { "id": "tests", "kind": "test", "argv": ["npm", "test"] }
  ],
  "forbiddenChanges": ["src/parser.ts is frozen except for the overflow branch"]
}
```

### Result

The result carries each layer as a sibling field:

```json
{
  "taskId": "fix-parser-overflow",
  "status": "completed",
  "finalState": "FINISHED",
  "finalResponse": "…",
  "error": null,

  "boundary":    { "readOnly": false, "violations": [] },
  "watchdog":    { "stallDetected": false, "events": [], "intervalMs": 5000, "llmIdleThresholdMs": 30000 },
  "steering":    { "steeringPerformed": false, "attempts": 0, "maxSteeringCount": 1,
                   "cooldownMs": 30000, "budgetExhausted": false, "events": [] },
  "timeout":     { "timedOut": false, "timeoutMs": 600000, "elapsedMs": 41230, "drainGraceMs": 5000 },

  "workspaceEvidence": {
    "verificationStatus": "available",
    "changedFiles": ["src/parser.ts", "test/parser.test.ts"],
    "diffStat": "2 files changed, 34 insertions(+), 2 deletions(-)",
    "workerDiffStat": "2 files changed, 34 insertions(+), 2 deletions(-)"
  },

  "verification": { "state": "satisfied", "checks": [ "…" ] },

  "gate":          { "decision": "accept", "reasonCodes": ["accepted"], "policy": {
                      "requireExecutionCompleted": true, "requireVerificationSatisfied": true } },

  "orchestration": { "action": "return", "status": "RETURNED",
                     "reasonCode": "gate-accepted", "gateReasonCodes": ["accepted"] }
}
```

Long sub-fields are elided with `…`. `status` is one of `completed`, `error`,
`aborted` or `timeout`; `finalState` is the nine-value normalized Worker state.

A coherent result can be `completed` + `unsatisfied` + `reject` + `return`.
That combination is meaningful, not contradictory: the Worker finished cleanly,
an explicit condition was not observed, policy declined to accept it, and the
evidence is returned for you to act on.

## Design principles

> **Delegate work, observe execution, intervene minimally, and return
> evidence.**

Two distinctions the whole design turns on:

```text
reject ≠ retry
unverifiable ≠ unsatisfied
```

`reject` means policy declined to accept the evidence. It does not trigger a
retry, and it is not an error. Retrying requires a retry policy, a budget,
revision rules and evidence invalidation — none of which exist here. The
evidence comes back to you and you decide.

`unsatisfied` means a stated condition was established *not* to hold.
`unverifiable` means no machine-checkable basis existed. Collapsing the second
into the first would turn an absence of evidence into evidence of failure.

## Non-goals

Deliberately out of scope:

```text
automatic retry          automatic repair
automatic planning       automatic scheduling
scope expansion          task revision
model selection          model lifecycle management
LLM quality scoring      fleet management
parallel Workers         remote Worker routing
resource leasing         persistent journals
recovery loops           recursive delegation
human inspection UI
```

A revised task is a new, explicit `worker_run` call — not a mutation of the
running one, and not something this extension initiates.

Model lifecycle is not managed here either. Which model is loaded, swapped or
unloaded belongs to the configured endpoint:

```text
Architect → worker_run → Pi AgentSession → llama-swap / configured runtime
```

## Configuration

All timing thresholds are configurable. None is a hidden constant. Set any of
these environment variables before starting pi; unset values use the shipped
default.

| Environment variable | Default | Purpose |
|---|---|---|
| `PI_WORKER_CWD` | current dir | Working directory for Worker runs. |
| `PI_WORKER_PROVIDER` | session default | Provider override for the Worker model. |
| `PI_WORKER_MODEL` | session default | Model id override for the Worker. |
| `PI_WORKER_THINKING` | session default | Thinking level: `off` `minimal` `low` `medium` `high` `xhigh` `max`. |
| `PI_WORKER_WATCHDOG_INTERVAL_MS` | 5000 | How often the watchdog evaluates. |
| `PI_WORKER_LLM_IDLE_MS` | 30000 | LLM silence before a probable stall. |
| `PI_WORKER_TIMEOUT_MS` | 600000 | Overall run deadline. |
| `PI_WORKER_DRAIN_GRACE_MS` | 5000 | Bounded wait for the session to wind down. |

Steering policy (`steeringEnabled`, `maxSteeringCount`, `steeringCooldownMs`)
and gate policy are part of the `WorkerHarness` API and default to enabled
steering with a single attempt, and to requiring both execution completion and
verification satisfaction. They are not exposed as environment variables in
the shipped extension.

## Development

```bash
npm install
npm run typecheck
npm test
npm run test:integration
```

`npm test` runs the unit suite. `npm run test:integration` exercises the real
model runtime and skips cleanly when no endpoint is configured.

## Documentation

- **[docs/SPEC_v0.2.md](docs/SPEC_v0.2.md)** — the formal specification.
  Describes the delivered architecture, responsibilities and invariants.
  Where any other document conflicts, this one governs.
- **[docs/SPEC_v0.1.md](docs/SPEC_v0.1.md)** — the legacy specification.
  Retained for historical traceability only. Superseded by v0.2.

## License

MIT. See [LICENSE](LICENSE).
