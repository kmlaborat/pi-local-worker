# pi-local-worker Specification v0.2

**Status:** Formal baseline.
**Supersedes:** SPEC v0.1 (§29 Implementation Plan only).
**Basis:** The implementation delivered in Steps 2–10 and reconciled in Step 11B.

This document does not introduce new design. It records, as specification, the
architecture, responsibilities, and invariants that the current code already
implements. Where SPEC v0.1 and the implementation differed, this document
follows the implementation.

---

## 1. Overview

`pi-local-worker` is a Pi extension that delegates a self-contained coding task
from an Architect agent to a local Worker agent, and returns a complete,
independently-derived evidence package describing what happened.

The Worker runs as an independent Pi `AgentSession` on the same machine as the
Architect. The extension neither manages nor observes model loading: that
belongs to the configured Worker endpoint.

The extension is a pipeline of layers, each answering exactly one question, and
none of them is permitted to become a source of semantic judgment about whether
the work was good.

---

## 2. Core Model

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
            │  OrchestrationResult
            ▼
        Architect
```

Responsibility split:

| Layer | Responsibility |
|---|---|
| Worker | execute |
| Evidence | observe |
| Verification | establish explicit conditions |
| Gate | apply policy |
| Orchestrator | select lifecycle action |
| Architect | decide meaning / next work |

Guiding principle:

> **Delegate work, observe execution, intervene minimally, and return evidence.**

The Worker does the work. The Architect decides what work should be done. The
extension reliably connects the two and hands back facts.

---

## 3. TaskSpec

The TaskSpec is the only thing that crosses the Architect → Worker boundary. It
must be self-contained: a Worker that needs a fact must find it in the TaskSpec
or discover it with its own tools. The Worker never receives the Architect's
conversation history.

### 3.1 Fields

| Field | Required | Type | Meaning |
|---|---|---|---|
| `taskId` | yes | string | Stable identifier chosen by the Architect. |
| `goal` | yes | string | What the Worker must accomplish. |
| `scope` | yes | string[] | Files, directories, symbols or areas the Worker may inspect or modify. |
| `workType` | yes | WorkType | Kind of work. Drives the work boundary and the default verification invariant. |
| `completionCriteria` | yes | string[] | Human-readable conditions for a complete task. **Not machine-checked.** |
| `completionChecks` | no | VerificationRequirement[] | Structured, machine-checkable completion requirements. The only authoritative input to verification. |
| `relevantSpec` | no | string | References to specs, docs, or issues. |
| `preconditions` | no | string[] | Conditions that must already hold. |
| `testRequirements` | no | string | Required testing approach (e.g. TDD). |
| `implementationConstraints` | no | string[] | Restrictions on the implementation. |
| `forbiddenChanges` | no | string[] | Changes the Worker must not make. |
| `expectedReport` | no | string[] | What the Worker should report back. |

### 3.2 There is no `validation` field

SPEC v0.1 §6.7 defined a prose `Validation` field. It is **not** part of this
specification and does not exist in the implementation.

It was removed because it described the same thing `completionChecks` expresses
machine-checkably, and was never connected to the verifier: a task declaring
`validation: ["npm test"]` ran no check and reported `unverifiable` without
warning. Two fields for one purpose, one of them inert, is a specification
defect. Express validation intent as a `command` or `test` entry in
`completionChecks`.

No conversion layer from `validation` to `completionChecks` exists, by design.

### 3.3 Prose criteria are context, not verification

`completionCriteria` is delivered to the Worker as prompt context and is
deliberately never reinterpreted into machine rules. A task that supplies only
prose criteria verifies as `unverifiable`, never as satisfied. Unknown stays
unknown rather than becoming a guess.

---

## 4. WorkType and the Work Boundary

`WorkType` is a closed set:

```text
investigate   review   test   implement   refactor   verify
```

Three of these are read-only:

```text
investigate   review   verify
```

### 4.1 The read-only classification is a single value

The set of read-only work types is a single, unified value in the implementation.
Two independent layers consume it:

- **The work boundary (Step 3)** blocks write-capable tools *before* they
  execute, for read-only work types.
- **Completion verification (Step 8)** applies an implicit `no-changes`
  invariant for read-only work types that supply no explicit workspace
  requirement.

These are different mechanisms applied to the same run, and they must mean the
same thing. The specification requires that they read one definition rather than
each maintaining its own, and that their agreement is pinned by test rather than
by convention.

A drift between them would allow a task to be enforced as read-only while being
verified as writable, or the reverse. That is treated as a defect, not a
tolerable divergence.

### 4.2 Boundary semantics

For a read-only work type:

```text
Worker requests write-capable tool
        ↓
Work Boundary evaluates the tool name
        ↓
blocked before execution, with a recorded reason
```

Tools are classified by explicit table lookup, not by name-pattern matching.
Write-capable built-ins include the file-writing tools and the shell tools,
because a shell can mutate the workspace with routinely available commands and a
"must not modify files" boundary cannot hold while they are permitted.

**Unknown tools fail closed.** A tool that is not classified as read-only is
blocked for read-only work rather than waved through.

For writable work types (`implement`, `refactor`, `test`) the boundary permits
all tools. The boundary is a pre-execution veto; it is not a post-hoc check.

The boundary is distinct from the `forbidden-files` verification requirement.
The boundary prevents an action; the verification observes a result. Both may
apply to the same run and neither substitutes for the other.

---

## 5. Worker Lifecycle

The extension maintains a normalized logical Worker state, deliberately
separated from the underlying session's event vocabulary so that the logical
model stays stable if the underlying event representation changes.

### 5.1 States

```text
INITIALIZING       Worker session being created; execution has not started.
WAITING_FOR_LLM    Active: no tool running, waiting for the next LLM activity.
LLM_GENERATING     Receiving assistant generation updates.
TOOL_EXECUTING     One or more tool calls in flight.
TURN_COMPLETED     A turn end was observed. NOT the same as the task being finished.
FINISHED           Settled normally.
ERROR              Settled with an error.
ABORTED          Settled after an abort.
TIMEOUT            Terminated by the overall deadline.
```

Terminal states: `FINISHED`, `ERROR`, `ABORTED`, `TIMEOUT`.

### 5.2 Completion is never prose-based

Worker completion is determined from session lifecycle signals, never from
natural-language output. A Worker saying `"Done"` is not evidence that the
session completed successfully.

Specifically:

- A turn end is not task completion. A Worker may complete many turns before the
  run finishes.
- The settled signal, not the last message, decides `FINISHED`.
- The final assistant text is returned as informational content only.

### 5.3 Session independence

Each Worker runs in its own session, created for the run. The Worker has no
access to the Architect's conversation. The TaskSpec prompt is the entire
context boundary.

The Worker must not expand its own scope. If the task cannot be completed within
the declared scope, the Worker reports the problem rather than silently widening
what it touches.

---

## 6. Watchdog

The Watchdog detects that LLM generation has probably stalled, and may intervene
minimally. It is an observation mechanism with a narrow intervention, not a
supervisor.

### 6.1 Stall condition

A probable stall requires all of:

```text
state == LLM_GENERATING
AND
pendingToolCalls == 0
AND
time since last LLM activity > llmIdleThresholdMs
```

The state check is the primary gate. The pending-tool check is a second,
independent guard on top of it.

### 6.2 Tool awareness

> **No LLM output does not imply an LLM stall.**

While a tool is executing the Worker legitimately produces no LLM output. A tool
in flight means silence is expected, so the Watchdog waits. This is a hard
requirement: active tool execution must never be classified as an LLM stall
merely because the LLM is quiet.

States other than `LLM_GENERATING` — including `WAITING_FOR_LLM`,
`TURN_COMPLETED`, and all terminal states — are never stall candidates. Any open
stall episode is closed when the state leaves `LLM_GENERATING`, so a later quiet
period is reported fresh.

### 6.3 Episode de-duplication

An ongoing stall is reported once. Repeated checks against the same unchanged
activity timestamp do not generate repeated events. A new quiet period after
activity resumes is a new episode.

### 6.4 Configuration

Both the check interval and the idle threshold are configurable. Neither may be
a hidden constant. Shipped defaults:

| Setting | Default |
|---|---|
| `watchdogIntervalMs` | 5,000 ms |
| `llmIdleThresholdMs` | 30,000 ms |

---

## 7. Steering

Steering is the Watchdog's only permitted intervention, and it is minimal.

### 7.1 The message

The steering message is exactly:

```text
.
```

It carries no task instruction. It is a wake-up probe intended to recover an
apparently stalled generation on the model side.

### 7.2 When steering must not occur

Steering is forbidden when:

- a tool is actively executing;
- the Worker has already finished;
- the Worker is aborted or otherwise terminal;
- the Worker is in any state that is not active generation;
- the steering budget is exhausted;
- the cooldown between attempts has not elapsed.

### 7.3 Budget and cooldown

Repeated steering requires an explicit policy. Both the maximum attempt count
and the minimum spacing are configurable rather than hidden:

| Setting | Default |
|---|---|
| `maxSteeringCount` | 1 |
| `steeringCooldownMs` | 30,000 ms |
| `steeringEnabled` | true |

Steering may be disabled entirely, which restores pure-observation behaviour.

### 7.4 Every decision is recorded

The result reports not only steering that happened but steering that was
suppressed, and why. A caller must be able to distinguish "no stall occurred"
from "a stall occurred but steering was disabled" from "a stall occurred and the
budget was exhausted". No boolean hides the behaviour.

### 7.5 What steering is not

Steering does not modify the prompt, the TaskSpec, the Worker's state machine,
or the run's terminal outcome. It is orthogonal to abort and timeout, which are
separate responsibilities.

---

## 8. Timeout, Abort, and Liveness

Three distinct mechanisms are deliberately kept separate.

```text
Timeout  = overall deadline on the Worker run
Watchdog = local observation of LLM liveness, with minimal steering
Abort    = explicit external cancellation
```

They must not be confused with one another. In particular, an overall timeout is
a safety mechanism and is not the Watchdog's idle threshold.

### 8.1 Timeout

A timeout is a lifecycle deadline over the whole Worker run. The budget starts
when the session is created and the prompt is about to run.

When the deadline fires:

```text
overall Worker run exceeds timeout
        ↓
TIMEOUT decided by the terminal arbiter
        ↓
Watchdog stopped
        ↓
cooperative abort requested
        ↓
bounded drain (wait for the session to reach idle, up to the grace window)
        ↓
session disposed
```

The drain is bounded. If the session does not reach idle within the grace
window, the harness disposes it anyway and records that fact. A non-responsive
tool may still be running afterwards; the run's outcome is already decided.

| Setting | Default |
|---|---|
| `workerTimeoutMs` | 600,000 ms (10 min) |
| `drainGraceMs` | 5,000 ms |

The timeout is independent of the Watchdog idle threshold and of the
verification command timeout.

### 8.2 Abort

An abort is an explicit external cancellation. It is decided at the drain
boundary and produces the `ABORTED` terminal outcome. Because the decision is
made immediately, the harness cannot distinguish "aborted and cleanly settled"
from "aborted and still winding down" beyond the `sessionDrained` flag.

### 8.3 Terminal arbitration

Several components could otherwise each decide the Worker's fate independently:
the state tracker, the timeout guard, the abort listener, and the settle path
after the prompt resolves.

The rule is **first valid decision wins**. There is no priority table. The race
cases are about ordering, not precedence, and a first-wins latch is the only
semantics that makes "no later event may change the terminal state" true.

Decisions that arrive after the winner are recorded for diagnostics and have no
effect.

### 8.4 Liveness guarantee

Every Worker run has a finite terminal outcome. No run can remain open
indefinitely.

---

## 9. Workspace Evidence

Workspace Evidence is the deterministic observation of workspace state before
and after Worker execution. It is produced independently of the Worker's own
report.

> Do not trust the Worker's report to determine what changed. Observe the
> workspace independently.

### 9.1 Evidence is not a verdict

Evidence carries no field expressing a judgment. There is no `correct`,
`passed`, `complete`, or `violated`. Deciding whether the Worker did the right
thing belongs to a later layer.

### 9.2 Content

| Field | Meaning |
|---|---|
| `verificationStatus` | `available` or `unavailable`. Whether observation succeeded. |
| `capturedAt` | When the final observation was taken. |
| `baseline` | Pre-run workspace summary: HEAD, branch, pre-existing dirty paths, pre-existing untracked paths, unborn-HEAD flag. |
| `changedFiles` | Files whose Git-visible identity differs between baseline and final. |
| `diffStat` | All tracked changes against HEAD, including pre-existing dirt. |
| `workerDiffStat` | `diffStat` restricted to Worker-changed paths. |
| `patch` | Diff text against HEAD, with truncation recorded. |
| `errors` | Machine-readable failure reasons. Non-empty only when unavailable. |
| `limitations` | Machine-readable caveats about what the evidence can and cannot show. |

### 9.3 Timing

- The **baseline** is captured before the Worker prompt runs.
- The **final** observation is taken after the drain, so a cooperatively
  finishing Worker's changes are included and the tree is quiescent.

### 9.4 Comparison is by identity, not by dirtiness

The comparison is by path and content identity, never by "is the tree dirty".
That is what makes a workspace that was already dirty before the Worker started
produce an empty Worker change set.

Where both sides carry a Git-comparable object id, the ids decide. Byte size is
used only where no object id is available, and that weakness is surfaced in
`limitations`.

### 9.5 Coverage

The observation handles added, modified, deleted, staged, unstaged, and untracked
files, and honours Git-reported renames and copies. An unstaged rename is
observed as delete plus add, because that is what Git reports before the pair is
staged; the extension does not invent rename detection.

### 9.6 Git is never mutated

The extension issues only read-only Git commands. It never adds, commits,
checks out, resets, cleans, stashes, reverts, restores, or pushes. There is no
capability in the evidence layer to modify the repository.

### 9.7 Unavailability is explicit

If observation fails, the result is `unavailable` with structured errors, and
downstream checks that depend on workspace evidence become `unverifiable` rather
than failing or silently passing. An empty `changedFiles` is proof of "nothing
changed" only when `verificationStatus` is `available`.

---

## 10. Completion Verification

Verification compares the TaskSpec's explicit, machine-checkable completion
conditions against the evidence.

### 10.1 Tri-state

```text
satisfied      The condition was established to hold.
unsatisfied    The condition was established NOT to hold.
unverifiable   The condition could not be established either way.
```

`unverifiable` is deliberately neither of the other two. Unknown is kept unknown
rather than collapsed into a guess. It is not a failure of the Worker.

### 10.2 Closed requirement kinds

The requirement vocabulary is a small closed set. There is no expression
language: no AND, OR, NOT, nesting, or arbitrary predicates. A new kind is
added only when a concrete TaskSpec needs one.

| Kind | Semantics |
|---|---|
| `changed-files` (mode `exact`) | The Worker-induced change set equals the expected set, no more and no less. |
| `changed-files` (mode `includes`) | The expected set is a subset of the Worker-induced change set. |
| `forbidden-files` | The intersection of the Worker-induced change set and the forbidden paths is empty. |
| `no-changes` | The Worker-induced change set is empty. |
| `command` / `test` | Run an argv-based validation command and read its exit code. |

`command` and `test` are the same mechanism with different intent; there is no
behavioural difference between them.

All workspace-dependent kinds are compared against the **Worker-induced** change
set, never the whole repository diff, so pre-existing dirt cannot skew the
result. `no-changes` is satisfied by a repository that was already dirty, as
long as the Worker itself changed nothing.

### 10.3 Read-only default

For a read-only work type that supplies no explicit workspace requirement, an
implicit `no-changes` requirement is applied. An explicit workspace requirement
overrides the default rather than being added alongside it.

Writable work types get no default. Such a task may legitimately leave no
persistent change, and inferring otherwise would be inventing semantics.

### 10.4 Aggregation

```text
any unsatisfied      → unsatisfied
else any unverifiable → unverifiable
else                → satisfied
```

An empty requirement list is `unverifiable`: with nothing checkable there is
nothing to establish, which is unknown rather than success.

### 10.5 Command execution is argv-based

Validation commands are argument vectors, not shell strings. Element zero is the
executable and the rest are its arguments. No shell is involved, so `&&`, `|`,
`;` and backticks are passed through as literal arguments rather than being
composed. Shell-command composition is structurally impossible.

Command execution is bounded. Each command has a finite timeout independent of
the Worker timeout, because an unbounded validation command could hold the
single Worker slot open forever. Default: 120,000 ms.

Command output is capped per stream. Truncation is recorded structurally — the
result carries the truncation flags and the byte limit that was applied — so a
truncated stream is distinguishable from a short one. Default cap: 32 KiB per
stream.

A command that times out, cannot be launched, or produces no exit code is
`unverifiable`, not `unsatisfied`. Nothing was established.

### 10.6 Verification is not a verdict on the Worker

`unsatisfied` means "an explicitly stated condition was not observed". It does
not mean "the Worker is bad". Verification is independent of execution status:
`completed` + `unsatisfied` and `timeout` + `satisfied` are both valid
combinations.

### 10.7 Verification never mutates

The verifier cannot steer, abort, retry, repair, revert, clean, checkout, stash,
commit, or reset. It never modifies the repository.

---

## 11. Gate

The Gate is a pure deterministic decision layer. It reads facts that already
exist — execution status and verification state — and assigns a policy outcome.

Verification answers "did this explicit machine-checkable condition hold?".
The Gate answers "given the execution and verification evidence, what state does
the configured policy assign?". Those are different questions and stay separate.

### 11.1 Decision

```text
accept    The evidence satisfies the policy.
reject    The evidence fails the policy.
inspect   The evidence does not support an automatic decision.
```

### 11.2 Policy

Policy is two independent, individually switchable requirements. It is
deliberately not a rule language: no AND/OR/NOT, no nesting, no expression
strings.

```text
requireExecutionCompleted:    true (default)
requireVerificationSatisfied: true (default)
```

With the default policy:

- A Worker whose execution status is not `completed` is rejected regardless of
  how good its evidence looks. This is why `timeout` + `satisfied` rejects.
- `unsatisfied` verification rejects.
- `unverifiable` verification — including the case where no machine-checkable
  requirement was ever supplied — goes to `inspect`, not `reject`. Absent
  evidence is not evidence of failure, and accepting it silently would accept
  work with no checkable basis at all.

Policy is injectable so that tests can prove the decision follows the policy
rather than a hard-coded default.

### 11.3 Aggregation

```text
any required check unsatisfied → reject
else any required check inspect → inspect
else                          → accept
```

Checks that the policy does not require are still recorded, so the observed fact
is preserved even when it does not drive the decision.

### 11.4 Reason codes

Closed set:

```text
accepted
execution-not-completed
verification-unsatisfied
verification-unverifiable
verification-missing
```

Codes are machine-readable and stable. The accompanying human-readable reason
text is generated from a fixed table and is never produced by a model.

### 11.5 Gate purity

The Gate has no capability to retry, repair, steer, abort, expand scope, touch
the filesystem, inspect Git, run commands, or call a model. It performs no I/O,
reads no clock, and uses no randomness.

This is not a stylistic claim. The Gate module's only dependency is the schema
library used to declare its own types. It cannot reach the Worker, the
filesystem, Git, a subprocess, or a model, because it holds no reference that
would make that possible.

### 11.6 Gate reject is not a retry

```text
reject ≠ retry
```

The Gate decides what the evidence means under policy. It takes no action on
that decision.

---

## 12. Orchestrator

The Orchestrator is the first component permitted to read Gate output as control
flow. It converts a Gate decision into a lifecycle action. That is the whole
job.

### 12.1 Mapping

The mapping is total over the closed three-value Gate decision:

```text
Gate accept    → return   / RETURNED
Gate reject    → return   / RETURNED
Gate inspect   → inspect  / INSPECTION_REQUIRED
```

An unknown Gate decision is not silently defaulted. The mapping is a lookup over
the closed `GateDecision` union, so an out-of-union value is a type error at
compile time; at runtime it produces a failed property access rather than being
coerced into a plausible action. There is no fallback branch that could quietly
turn an unexpected value into `return`.

### 12.2 Action semantics

**`return`** — the Worker lifecycle is finished and its complete evidence
package is deliverable to the caller. It does **not** mean the task succeeded,
the implementation is correct, or a human approved anything.

**`inspect`** — a higher-level consumer must look before anything proceeds.
The Orchestrator performs no inspection of its own: no model call, no review,
no Worker query, no TaskSpec edit. It exposes the requirement and preserves the
evidence.

Neither action is an error. `reject ≠ error` and `inspect ≠ error`. Collapsing
either into an error state would destroy the distinction the earlier layers
established.

### 12.3 Reason codes

```text
gate-accepted
gate-rejected
gate-inspection-required
```

These name why the action follows. The Gate's own, more specific reason codes
are carried alongside unchanged. The Orchestrator adds a code; it never
substitutes one. `verification-unsatisfied` stays visible as itself and is never
rewritten into something like `worker-failed`.

### 12.4 Reject does not retry

`reject` returns rather than retrying because retry requires a retry policy, a
retry budget, task-revision rules, failure classification, scope preservation,
and evidence invalidation rules. None of those exist, and each is its own design
problem. Returning preserves every fact so the Architect can make that call.

### 12.5 Orchestrator purity

The Orchestrator reads only the Gate decision. It performs no I/O, reads no
clock, uses no randomness, and has no async side effects. Its module has no
runtime import at all — its only dependency is erased at compile time.

It does not call a model, re-run a Worker, modify a TaskSpec, touch the
workspace, retry, or repair.

### 12.6 The action is deliberately low-resolution

Both `accept` and `reject` yield `return`. A consumer that needs to know which
must read the Gate result. The action field answers "what does the lifecycle do
next", not "was the work good".

---

## 13. Evidence Layers in the Worker Result

The Worker result carries each layer as a sibling. Nothing is collapsed into a
string, nothing is duplicated, and nothing is discarded.

```text
WorkerResult
├── execution / status
├── workspaceEvidence
├── verification
├── gate
└── orchestration
```

Each answers a different question:

| Layer | Question |
|---|---|
| Execution | How did the Worker terminate? |
| Evidence | What happened in the workspace? |
| Verification | Is there evidence the required conditions were met? |
| Gate | How should that result be treated under policy? |
| Orchestrator | What is the next lifecycle action? |

This separation is a core design principle of v0.2. These layers are not to be
merged into a single "success detector".

The layers are independent and their combination space is meaningful. For
example:

```text
execution = completed
verification = unsatisfied
gate = reject
orchestration = return
```

is a valid, coherent result. The Architect receives the evidence and decides
what to do next.

Adding the orchestration field is purely additive: removing it leaves a
fully-formed result from the earlier layers.

---

## 14. N=1 Concurrency

v0.2 permits exactly one Worker run at a time.

```text
pi-local-worker allows exactly one concurrent Worker run.
```

The concurrency slot is held from the start of the Worker run until orchestration
completes:

```text
Worker → evidence → verification → gate → orchestration → release slot
```

A second run requested while the slot is held is refused, not queued. Re-entrant
Worker creation is rejected.

The slot is deliberately not released at Worker termination. The orchestration
steps are pure and need no Worker resource, so the slot could technically be
released earlier. It is held anyway so that no second Worker can start while the
first run's outcome is still undecided. This costs nothing measurable and is the
safer invariant.

---

## 15. Purity and Dependency Direction

The conceptual dependency direction is:

```text
Worker
  ↓
Evidence
  ↓
Verification
  ↓
Gate
  ↓
Orchestrator
```

Actual implementation dependencies are permitted only downward, to the lower
types a layer legitimately needs. There are no upward dependencies and no
circular dependencies.

The Gate and the Orchestrator are deterministic pure layers. They depend on
none of:

```text
time
randomness
filesystem
process execution
async side effects
```

Their purity is enforced structurally rather than by convention: the compiler
configuration requires explicit type-only imports, so a value import that would
grant a capability cannot be introduced silently.

The composition root — the component that owns the Worker lifecycle — is the
only module that knows about all layers. No lower layer knows about a higher one.

---

## 16. No Automatic Recovery

The following are explicitly out of scope for v0.2:

```text
automatic retry
automatic repair
automatic planning
automatic scheduling
automatic scope expansion
automatic task revision
model selection
model lifecycle management
LLM quality scoring
fleet management
parallel Workers
remote Worker routing
resource leasing
persistent journals
recovery loops
recursive delegation
human inspection UI
```

Gate reject is not a retry mechanism. Orchestrator inspect is not an inspection
implementation. Nothing in the pipeline acts on an unfavourable outcome.

The Architect receives the result, decides what it means, and creates the next
TaskSpec if one is warranted. That is a new, explicit delegation.

A related invariant: the extension never mutates a TaskSpec during a Worker run.
No code path writes to a TaskSpec field after the run begins. A revised task is a
new delegation with a new TaskSpec, not an in-place edit of the running one.
This is a behavioural invariant rather than a type-level one: the TaskSpec type
does not mark its fields `readonly`, so the guarantee comes from the absence of
mutation rather than from the compiler.

---

## 17. Model Lifecycle

`pi-local-worker` does not manage model lifecycle.

```text
Architect
    ↓
worker_run
    ↓
Pi AgentSession
    ↓
llama-swap / configured runtime
```

Which model is loaded, swapped, or unloaded is not the extension's concern. The
extension never issues load, unload, or switch operations. Model configuration
is passed through as settings; model behaviour is owned by the endpoint.

Worker implementation is model-agnostic. The extension depends on the session
interface, not on any particular model's behaviour.

---

## 18. Error Semantics

The following are distinct and must not be conflated:

```text
ERROR                      Worker terminated with an error
ABORTED                    Worker terminated by explicit cancellation
TIMEOUT                    Worker terminated by the overall deadline
verification.unsatisfied   An explicit condition was established not to hold
verification.unverifiable  No machine-checkable basis existed
gate.reject                Policy declined to accept the result
gate.inspect               Policy could not decide automatically
```

Specifically:

```text
Worker ERROR            ≠  verification unsatisfied
verification unsatisfied ≠  retry
gate reject             ≠  retry
gate inspect            ≠  error
```

A command that exits non-zero is a verification outcome, not a Worker execution
error. A Worker that terminates cleanly while failing a required check is
`completed` + `unsatisfied` + `reject`, which is a normal, meaningful
combination.

The extension never silently broadens the task scope after an error.

---

## 19. Responsibility Boundaries

The boundary between the four decision-adjacent layers is the central design
constraint of v0.2:

```text
Evidence:
  "what happened"

Verification:
  "is there evidence the required conditions were met"

Gate:
  "how should that result be treated under policy"

Orchestrator:
  "what lifecycle action follows from that decision"
```

These are not to be unified. Merging any adjacent pair produces a component that
both observes and judges, or both judges and acts, which is precisely the failure
mode this architecture is built to prevent.

The crucial invariant:

> **The Orchestrator may control lifecycle, but it must not become the source of
> semantic judgment.**

And:

> **Gate reject does not mean retry; it means return the evidence to the
> Architect.**

---

## 20. Security and Isolation

The isolation properties the current design provides:

- **Session isolation.** The Worker runs in an independent session with no
  access to the Architect's conversation.
- **Prompt-level scope isolation.** The TaskSpec prompt is the entire context
  boundary. Nothing crosses it implicitly.
- **Resource isolation.** The Worker session is constructed with its own
  resource loading rather than inheriting the Architect's loaded resources.
- **Work boundary on write-capable tools.** For read-only work types, tools that
  can mutate the workspace are blocked before execution via the session's native
  tool-call veto. No filesystem patching, no post-hoc inspection.
- **Fail-closed on unknown tools.** A tool not classified as read-only is
  blocked for read-only work rather than permitted by default.
- **No shell composition.** Validation commands are argv vectors with the shell
  explicitly disabled, so injected shell metacharacters are inert.
- **No repository mutation.** Only read-only Git commands are issued anywhere in
  the extension.
- **No persistence.** The extension writes no files and maintains no journal.
  Nothing survives the run.

---

## 21. Configuration Reference

All timing thresholds are configurable. None is a hidden constant.

| Setting | Default | Purpose |
|---|---|---|
| `watchdogIntervalMs` | 5,000 ms | How often the Watchdog evaluates. |
| `llmIdleThresholdMs` | 30,000 ms | LLM silence before a probable stall. |
| `steeringEnabled` | true | Whether steering may occur at all. |
| `steeringCooldownMs` | 30,000 ms | Minimum spacing between steering attempts. |
| `maxSteeringCount` | 1 | Hard cap on steering attempts per run. |
| `workerTimeoutMs` | 600,000 ms | Overall run deadline. |
| `drainGraceMs` | 5,000 ms | Bounded wait for the session to wind down. |
| verification command timeout | 120,000 ms | Per-command bound. |
| command output cap | 32 KiB / stream | Retained output bound. |
| patch cap | 256 KiB | Retained diff text bound. |
| hash size cap | 2 MiB | Files above this are compared by size only. |
| listed path cap | 200 | Pre-existing dirty/untracked paths listed. |

Gate policy is injectable through the harness API but is not exposed as an
environment setting in the shipped extension; the shipped extension always uses
the default policy.

---

## 22. Implementation Baseline

The following is the delivered baseline this specification describes. It is a
record of what exists, not a forward plan.

| Step | Delivered |
|---|---|
| 2 | Minimal Worker — TaskSpec → independent session → result. |
| 3 | State normalization and work boundary. |
| 4 | Watchdog — tool-aware stall detection. |
| 5 | Steering — minimal `.` wake-up with budget and cooldown. |
| 6 | Timeout, abort, liveness boundary, terminal arbitration. |
| 7 | Deterministic workspace evidence. |
| 8 | Deterministic completion verification. |
| 9 | Deterministic Gate. |
| 10 | Minimal Orchestrator. |
| 11B | Implementation consistency reconciliation. |
| — | Dependency audit and runtime-dependency classification. |

Step 11B reconciled the implementation with the design intent recorded here:
the read-only work-type classification was unified to a single source; the inert
prose `validation` field was removed in favour of `completionChecks`; command
output truncation became structurally recorded; and documentation that
contradicted the code was corrected.

---

## 23. Differences from SPEC v0.1

For traceability, the substantive changes from v0.1:

| Area | v0.1 | v0.2 |
|---|---|---|
| Scope of plan | Ended at Step 7 "Evaluation". | Steps 2–10 plus reconciliation, as delivered baseline. |
| Gate | "intentionally not required for the first implementation". | Required and implemented as a pure policy layer. |
| Orchestrator | Not mentioned. | Specified as the lifecycle-action selection layer. |
| Workspace Evidence | Not mentioned. | Specified as the independent observation layer. |
| `completionChecks` | Not mentioned. | The authoritative verification input. |
| `validation` field | Specified in §6.7. | Removed. Never wired to verification; superseded by `completionChecks`. |
| Tri-state verification | Not mentioned. | `satisfied` / `unsatisfied` / `unverifiable` specified, with unverifiable explicitly not a failure. |
| N=1 concurrency | Not mentioned. | Specified as a hard invariant with slot held through orchestration. |
| Timeout vs Watchdog | Loosely separated. | Three-way separation: timeout / watchdog / abort. |
| Terminal arbitration | Not mentioned. | First-wins latch specified. |
| Purity requirements | Not stated. | Stated and structurally compiler-enforced. |
| Error semantics | Listed as error kinds. | Explicit non-conflation rules across layers. |

v0.1 remains available as a historical document. Where the two conflict, v0.2
governs.
