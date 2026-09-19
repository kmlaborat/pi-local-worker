# pi-local-worker Specification v0.1

## 1. Overview

`pi-local-worker` is a Pi extension for delegating self-contained coding tasks from an Architect agent to a local Worker agent.

The Worker runs as an independent Pi `AgentSession` on the same machine as the Architect.

The extension provides:

* Task-based delegation
* Independent Worker sessions
* Worker lifecycle monitoring
* Tool-execution-aware watchdog monitoring
* Minimal wake-up steering for probable LLM stalls
* Structured result reporting

The extension does **not** manage model loading, unloading, or model switching. Those responsibilities belong to the configured Worker endpoint and, in the current deployment, to `llama-swap`.

---

# 2. Goals

The primary goals are:

1. Allow an Architect agent to delegate a well-defined task to a Worker.
2. Run the Worker in an independent AgentSession.
3. Keep the Worker task self-contained and independent from the Architect's conversation history.
4. Observe Worker execution state.
5. Distinguish LLM inactivity from active tool execution.
6. Detect probable Worker stalls.
7. Provide minimal wake-up steering when appropriate.
8. Return the Worker's result to the Architect.
9. Keep the extension small and focused.

---

# 3. Design Principles

## 3.1 Scratch Implementation

The implementation must be written from scratch.

The current Pi API, documentation, and official examples should be treated as the primary technical reference.

Implementation decisions should be based on the requirements of this specification rather than copied from other extensions.

When the behavior of the current Pi API is uncertain, inspect the current Pi source or examples before making assumptions.

---

## 3.2 Minimal Responsibility

`pi-local-worker` is a Worker delegation and monitoring extension.

It is not:

* a workflow engine
* a DAG scheduler
* a model manager
* a model router
* a distributed worker system
* a quality-ranking system

The extension should implement only the functionality required to delegate and monitor a local Worker.

---

## 3.3 Local-First Architecture

Version 0 assumes that Architect and Worker operate on the same machine.

```text
┌──────────────────────────────────────────────┐
│                  Same Machine                │
│                                              │
│  Architect Pi                                │
│       │                                      │
│       │ TaskSpec                             │
│       ▼                                      │
│  pi-local-worker                             │
│       │                                      │
│       │ AgentSession                         │
│       ▼                                      │
│  Worker                                      │
│       │                                      │
│       ▼                                      │
│  Worker endpoint / model runtime             │
│                                              │
└──────────────────────────────────────────────┘
```

Remote Worker routing is outside the scope of v0.

The implementation should nevertheless avoid unnecessary coupling to local model management so that a future remote Worker architecture remains possible.

---

# 4. Non-Goals

The following are explicitly outside the scope of v0:

* DAG scheduling
* Wave scheduling
* Multiple dependent Workers
* Worker fleets
* Nested Worker delegation
* Distributed execution
* Remote Worker discovery
* Worker routing
* Resource leasing
* Persistent workflow journals
* Complex workflow recovery
* Automatic retry policies
* Automatic model selection
* Model load/unload control
* Direct model-runtime control
* LLM-based quality scoring
* Automatic scope expansion
* Automatic correction after validation failure
* Fleet-oriented TUI

These may be considered in future versions if actual use cases justify them.

---

# 5. Terminology

## 5.1 Architect

The parent Pi agent responsible for planning work, creating TaskSpecs, delegating tasks, and interpreting Worker results.

## 5.2 Worker

An independent Pi `AgentSession` that executes a delegated TaskSpec.

## 5.3 Task

A self-contained unit of work delegated from Architect to Worker.

## 5.4 Phase

A meaningful, completable work unit within a larger development task.

A Phase is **not** defined as one validation command.

The preferred principle is:

> **One Phase = one completable work unit + one clear validation condition.**

Examples:

* investigation
* review
* test implementation
* implementation
* refactoring
* verification

## 5.5 TaskSpec

A self-contained specification given to the Worker.

The Worker should be able to execute the TaskSpec without access to the Architect's conversational history.

---

# 6. TaskSpec

A TaskSpec SHOULD contain the following information:

```text
TaskSpec
├── Task ID
├── Goal
├── Relevant Spec
├── Scope
├── Preconditions
├── Work Type
├── Test / TDD Requirements
├── Validation
├── Implementation Constraints
├── Completion Criteria
├── Forbidden Changes
└── Expected Report
```

The exact serialization format is an implementation detail and may evolve.

## 6.1 Goal

A concise description of what the Worker must accomplish.

## 6.2 Relevant Spec

References to specifications, design documents, issues, or other authoritative instructions.

## 6.3 Scope

The files, symbols, directories, or conceptual areas that the Worker may inspect or modify.

## 6.4 Preconditions

Conditions that must already be true before execution begins.

## 6.5 Work Type

Examples:

```text
investigate
review
test
implement
refactor
verify
```

## 6.6 Test / TDD Requirements

When applicable, the TaskSpec should explicitly define the required testing approach.

For implementation work, Spec-driven TDD is preferred.

## 6.7 Validation

The TaskSpec should describe how completion is to be verified.

Examples:

```text
npm test
npm run typecheck
git diff --check
```

## 6.8 Implementation Constraints

Restrictions that apply to the implementation.

## 6.9 Completion Criteria

Explicit conditions that define a complete task.

## 6.10 Forbidden Changes

Changes that the Worker must not make.

For review or investigation tasks, this SHOULD explicitly state:

```text
No file modifications are allowed.
```

## 6.11 Expected Report

The information the Worker should return to the Architect.

---

# 7. Phase-Based Development Policy

The recommended development policy is:

> **Spec-driven TDD + phase-based delegation**

A Phase should be large enough to represent meaningful work but small enough that its completion can be clearly determined.

Example:

```text
Phase 1 — Investigation
    Expected diff: 0

Phase 2 — Test implementation
    Expected diff: test files only

Phase 3 — Implementation
    Expected diff: implementation files

Phase 4 — Verification
    Expected diff: 0
    Validation: full test suite
```

The extension itself does not automatically schedule these phases in v0.

The Architect is responsible for deciding how work should be divided.

---

# 8. Worker Harness

The Worker Harness is responsible for creating and managing the Worker `AgentSession`.

Conceptually:

```text
TaskSpec
   │
   ▼
createAgentSession()
   │
   ▼
subscribe to events
   │
   ▼
execute TaskSpec
   │
   ├── LLM activity
   ├── tool execution
   ├── turn completion
   ├── finish
   └── error
```

The Worker Harness MUST:

* create an independent Worker session
* provide the TaskSpec to the Worker
* observe Worker lifecycle events
* maintain normalized Worker state
* detect completion
* detect errors and aborts
* expose the final result

The Worker Harness MUST NOT assume that the Worker has access to the Architect's conversation history.

---

# 9. Context Isolation

The Worker should receive only the context required by its TaskSpec.

The Architect's entire conversation history MUST NOT be implicitly transferred to the Worker.

The TaskSpec is the primary context boundary.

This provides:

* predictable Worker context size
* clearer task boundaries
* lower context overhead
* easier debugging
* easier reproducibility
* independence from the Architect's conversational state

Project-level instructions may still be available according to normal Pi/session behavior unless explicitly isolated by the implementation.

The extension should avoid accidental contamination from the Architect session.

---

# 10. Worker State

The extension should maintain a normalized logical Worker state.

Suggested states:

```text
INITIALIZING
WAITING_FOR_LLM
LLM_GENERATING
TOOL_EXECUTING
TURN_COMPLETED
FINISHED
ERROR
ABORTED
TIMEOUT
```

The exact internal state machine may be refined during implementation.

The important requirement is that the extension can distinguish at least:

1. Worker initialization
2. LLM activity
3. Tool execution
4. Turn completion
5. Worker completion
6. Error
7. Abort
8. Timeout

---

# 11. Event Normalization

Pi's native events and the extension's logical Worker state must be separated.

```text
Pi AgentSession events
          │
          ▼
    Worker Harness
          │
          ▼
   Normalized state
          │
          ├── Watchdog
          ├── completion detection
          └── result handling
```

The implementation MUST verify the currently available Pi event names and payloads rather than relying on assumptions about the API.

The normalized state should remain stable even if the underlying Pi event representation changes.

---

# 12. Watchdog

The Watchdog monitors Worker activity and detects probable stalls.

The Watchdog is an observation and limited intervention mechanism.

It must not attempt to supervise every aspect of Worker behavior.

At minimum, the Watchdog should track:

```text
currentState
lastActivityAt
lastTokenAt
activeToolCount
```

Additional timestamps or counters may be added if required.

---

# 13. Tool-Aware Stall Detection

A Worker may produce no LLM output while a Tool is executing.

Examples include:

```text
pytest
npm test
git
file operations
web requests
```

Therefore:

> **No LLM output does not imply an LLM stall.**

If the Worker is actively executing a Tool, the Watchdog should normally wait rather than trigger LLM stall recovery.

Conceptually:

```text
if TOOL_EXECUTING:
    wait

else if LLM idle > configured threshold:
    probable stall
```

The actual state determination must use the available Pi AgentSession events.

---

# 14. Watchdog Thresholds

Time thresholds MUST be configurable.

The implementation must not hard-code a specific value such as 30 seconds as the only stall threshold.

At minimum:

```text
watchdogInterval
llmIdleThreshold
```

should be configurable.

Reasonable defaults may be provided.

---

# 15. Wake-Up Steering

When a probable LLM stall is detected, the Watchdog may send a minimal steering message to the Worker:

```text
.
```

The purpose of this message is not to provide new task instructions.

It is a minimal wake-up intervention intended to recover from an apparent LLM-side stall.

Steering MUST NOT occur when:

* a Tool is actively executing
* the Worker has already finished
* the Worker is aborted
* the Worker is in an invalid lifecycle state for steering

The steering mechanism should use the native Pi session steering capability where available.

---

# 16. Steering Policy

The Watchdog should prefer the smallest possible intervention.

```text
observe
   ↓
classify state
   ↓
Tool active?
   ├── yes → wait
   └── no
        ↓
LLM idle beyond threshold?
   ├── no → wait
   └── yes
        ↓
probable stall
        ↓
steer(".")
```

Repeated steering should not occur without an explicit policy.

An implementation may include a cooldown or maximum steering count if required by observed behavior.

Such limits should be configurable rather than hidden constants.

---

# 17. Completion Detection

Worker completion must be based on AgentSession lifecycle information, not solely on natural-language output.

The extension should distinguish:

```text
normal completion
error
abort
timeout
```

A Worker saying:

```text
Done
```

is not by itself sufficient evidence that the Worker session has completed successfully.

---

# 18. Result Model

The Worker result should contain, at minimum:

```text
Task ID
Status
Final response
Changed files
Validation information
Error information
```

The exact representation is an implementation detail.

The final natural-language Worker response is informational.

It must not be treated as deterministic verification.

---

# 19. Work Boundary

TaskSpec explicitly defines what the Worker is allowed to do.

### Investigation

```text
Work Type: investigate

Expected:
- inspect the relevant code
- report findings
- do not modify files

Expected diff:
0
```

### Review

```text
Work Type: review

Expected:
- analyze the requested implementation
- report findings
- do not modify files

Expected diff:
0
```

### Implementation

```text
Work Type: implement

Expected:
- implement the specified change
- modify only files within the defined scope
- run the specified validation

Expected diff:
non-zero, within expected scope
```

The extension should make these boundaries observable where possible.

---

# 20. Deterministic Verification

Worker self-reporting and deterministic verification are separate concepts.

For example:

```text
Worker:
"All tests pass."

Deterministic verification:
npm test → exit code 1
```

The system must not treat the Worker statement as authoritative over the actual command result.

A future Gate component may perform deterministic verification using:

* command exit codes
* test results
* git diff
* changed-file lists
* invariant checks

Gate is intentionally not required for the first implementation.

---

# 21. Model Lifecycle

`pi-local-worker` MUST NOT directly manage Worker model lifecycle.

It must not directly issue operations such as:

```text
load model
unload model
switch model
```

The extension interacts with the configured Worker endpoint.

In the current local deployment, model switching is delegated to `llama-swap`.

```text
Architect
    │
    ▼
pi-local-worker
    │
    ▼
Worker endpoint
    │
    ▼
llama-swap
    │
    ├── Architect model
    └── Worker model
```

This separation is intentional.

---

# 22. Model-Agnostic Design

The extension must not depend on a specific Worker model.

The Worker may be implemented using:

* a local llama.cpp model
* another local runtime
* a different model endpoint

The extension should depend on the AgentSession / Worker interface rather than model-specific behavior.

---

# 23. Error Handling

The extension should distinguish the following conditions where possible:

```text
TASK_ERROR
WORKER_ERROR
WORKER_ABORTED
WORKER_TIMEOUT
WATCHDOG_STALL
VALIDATION_FAILURE
```

v0 does not require automatic retry.

When a Worker fails, the Architect should receive enough information to decide what to do next.

The extension must not silently broaden the task scope after an error.

---

# 24. Timeout

A Worker execution timeout SHOULD be configurable.

Timeout handling must distinguish:

* active Tool execution
* LLM inactivity
* overall Worker runtime

An overall timeout is a safety mechanism and must not be confused with the Watchdog's LLM idle threshold.

---

# 25. Architect Responsibility

The Architect is responsible for:

* identifying suitable work for delegation
* splitting work into Tasks / Phases
* generating TaskSpecs
* defining scope
* defining validation conditions
* interpreting Worker results
* deciding whether another Task is required
* performing final architectural judgment

The Worker Extension should not replace the Architect's planning role.

---

# 26. Worker Responsibility

The Worker is responsible for:

* following the TaskSpec
* inspecting relevant code
* making permitted changes
* running requested tests or validation
* respecting Forbidden Changes
* reporting results

The Worker should not independently redefine the TaskSpec.

If the Task cannot be completed within the specified scope, the Worker should report the problem rather than silently expanding the scope.

---

# 27. Batch Delegation

v0 does not require an automatic scheduler.

The Architect may nevertheless create multiple TaskSpecs and execute them as a Worker batch.

Preferred operational pattern:

```text
Architect phase
    │
    ├── Task 1
    ├── Task 2
    └── Task 3
         │
         ▼
Worker phase
    │
    ├── Task 1
    ├── Task 2
    └── Task 3
         │
         ▼
Architect review phase
```

This allows model switching overhead to be reduced when the local runtime supports model switching.

Scheduling policy remains outside the extension in v0.

---

# 28. Future Architecture

The current architecture is intentionally compatible with a future Worker endpoint abstraction.

Current:

```text
Architect
    ↓
pi-local-worker
    ↓
local Worker
```

Potential future architecture:

```text
Architect
    ↓
Worker Router
    ↓
Worker Endpoint
    ├── local Worker
    ├── remote Worker
    ├── other local runtime
    └── other Worker
```

The v0 implementation should avoid coupling its delegation semantics to local model management so that this evolution remains possible.

---

# 29. Implementation Plan

## Step 1 — Verify Pi API

Before implementing the Worker, inspect the current Pi API, documentation, source, and examples to verify:

* `createAgentSession`
* AgentSession lifecycle
* event subscription
* message events
* tool execution events
* `steer()`
* abort
* final response retrieval
* session cleanup

No implementation changes should be made during this investigation step.

---

## Step 2 — Minimal Worker

Implement only:

```text
TaskSpec
    ↓
AgentSession
    ↓
execute
    ↓
result
```

The Worker must successfully execute a simple self-contained TaskSpec.

---

## Step 3 — Event Normalization

Add the normalized Worker state machine.

Verify that the implementation can distinguish:

* LLM activity
* Tool execution
* turn completion
* Worker completion
* error
* abort

---

## Step 4 — Watchdog

Implement observation of Worker activity.

Verify that active Tool execution does not trigger false LLM-stall detection.

---

## Step 5 — Wake-Up Steering

Implement configurable LLM idle detection and minimal:

```text
.
```

steering.

Test recovery from an actual or reproducible stalled state where possible.

---

## Step 6 — Error and Timeout Handling

Implement explicit handling for:

* normal completion
* Worker error
* abort
* timeout
* watchdog stall

---

## Step 7 — Evaluation

Use representative Tasks to verify task-boundary behavior.

### Test A — Investigation

Expected:

```text
diff = 0
```

### Test B — Review

Expected:

```text
diff = 0
```

### Test C — Test implementation

Expected:

```text
test files changed
```

### Test D — Implementation

Expected:

```text
specified implementation changes
```

### Test E — Verification

Expected:

```text
diff = 0
validation executed
```

---

# 30. Core Invariants

## INV-1 — Task Isolation

A Worker can execute its TaskSpec without requiring the Architect's conversational history.

## INV-2 — Explicit Scope

The Worker must operate within the scope defined by the TaskSpec.

## INV-3 — No Guessing

The Worker must not silently expand scope when the TaskSpec is insufficient.

## INV-4 — Tool-Aware Watchdog

Active Tool execution must not be classified as an LLM stall merely because the LLM produces no output.

## INV-5 — Minimal Intervention

Watchdog intervention must be limited to the minimum necessary steering.

## INV-6 — Configurable Timing

Watchdog and timeout thresholds must be configurable.

## INV-7 — Lifecycle Separation

Worker lifecycle management must remain separate from model lifecycle management.

## INV-8 — Model-Agnostic Worker

The extension must not depend on a particular Worker model.

## INV-9 — Deterministic Verification Separation

Worker self-reporting must remain distinct from deterministic validation.

## INV-10 — Reference Independence

The implementation must not depend on third-party Worker or subagent extensions.

---

# 31. v0 Success Criteria

Version 0 is successful when all of the following are demonstrated:

1. The Architect can submit a self-contained TaskSpec.
2. A Worker can execute the TaskSpec in an independent AgentSession.
3. Worker lifecycle events can be observed.
4. LLM activity and Tool execution can be distinguished.
5. Active Tool execution does not cause false stall recovery.
6. Configurable LLM idle detection works.
7. The Watchdog can perform minimal `.` steering when appropriate.
8. Worker completion can be detected reliably.
9. Worker errors, aborts, and timeouts can be reported.
10. Worker results can be returned to the Architect.
11. Review and investigation Tasks can enforce a zero-change expectation.
12. Model switching remains outside the extension.
13. The implementation has no dependency on third-party subagent implementations.
14. The implementation is small enough that the Worker delegation mechanism remains understandable and independently testable.

---

# 32. Guiding Principle

The extension should follow the principle:

> **Delegate work, observe execution, intervene minimally, and return evidence.**

The Worker is responsible for doing the work.

The Architect is responsible for deciding what work should be done.

The extension is responsible for reliably connecting the two.
