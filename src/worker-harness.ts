import { join } from "node:path";

import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	getAgentDir,
	type AgentSessionEvent,
	type AgentSessionEventListener,
	type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";

import { GitObserver, type GitRunner, type GitSnapshot } from "./git-observer.ts";
import {
	isReadOnlyWorkType,
	renderTaskSpecPrompt,
	type TaskSpec,
	type WorkType,
} from "./task-spec.ts";
import { deriveRequirements, verifyRequirements } from "./completion-verifier.ts";
import {
	DEFAULT_GATE_POLICY,
	evaluateGate,
	type GateEvidence,
	type GatePolicy,
} from "./gate.ts";
import { orchestrate, type OrchestrationDecision } from "./orchestrator.ts";
import {
	DEFAULT_VERIFICATION_COMMAND_TIMEOUT_MS,
	type CommandRunner,
	spawnCommandRunner,
	type VerificationEvidence,
} from "./verification.ts";
import { collectWorkspaceEvidence, type WorkspaceEvidence } from "./workspace-evidence.ts";
import {
	BoundaryRecorder,
	createWorkBoundaryExtension,
	type BoundaryViolation,
} from "./work-boundary.ts";
import {
	lastAssistantStopReason,
	WorkerStateTracker,
	type WorkerState,
	type WorkerStateSnapshot,
} from "./worker-state.ts";
import {
	createSystemWatchdogScheduler,
	DEFAULT_LLM_IDLE_THRESHOLD_MS,
	DEFAULT_WATCHDOG_INTERVAL_MS,
	WorkerWatchdog,
	type WatchdogScheduler,
	type WorkerStallEvent,
} from "./watchdog.ts";
import {
	DEFAULT_MAX_STEERING_COUNT,
	DEFAULT_STEERING_COOLDOWN_MS,
	isTerminalWorkerState,
	SteeringController,
	type SteeringActuator,
	type WorkerSteeringEvent,
} from "./steering.ts";
import {
	createSystemTimerScheduler,
	type TimerHandle,
	type TimerScheduler,
} from "./timer.ts";
import { TerminalArbiter, type TerminalCause } from "./terminal-arbiter.ts";
import {
	DEFAULT_DRAIN_GRACE_MS,
	DEFAULT_WORKER_TIMEOUT_MS,
	WorkerTimeoutGuard,
	type WorkerTimeoutInfo,
} from "./timeout.ts";

/** Thinking levels accepted by pi (mirrors pi-agent-core; not re-exported at package root). */
export type WorkerThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface WorkerHarnessConfig {
	/** Working directory the Worker runs in. */
	cwd: string;
	/** pi config directory. Defaults to `getAgentDir()`. */
	agentDir?: string;
	/** Provider id for the Worker model. Omit -> pi settings default. */
	provider?: string;
	/** Model id for the Worker model. Omit -> pi settings default. */
	modelId?: string;
	/** Thinking level. Omit -> pi settings default. */
	thinkingLevel?: WorkerThinkingLevel;
	/**
	 * Reuse an existing ModelRuntime instead of creating one.
	 * Only used when `provider` + `modelId` are set.
	 */
	modelRuntime?: ModelRuntime;
	/**
	 * Test seam. Defaults to the real `createAgentSession`.
	 *
	 * The return type is the narrow `WorkerSession` surface below, which the real
	 * `AgentSession` is proven to satisfy at compile time
	 * (see test/api-conformance.test.ts).
	 */
	createSession?: (options: CreateAgentSessionOptions) => Promise<{ session: WorkerSession }>;
	/**
	 * Narrow internal/debug hook. Called with a fresh snapshot whenever the
	 * normalized Worker state changes. Not an Architect-facing polling API.
	 */
	onStateChange?: (snapshot: WorkerStateSnapshot) => void;
	/**
	 * How often the watchdog evaluates the Worker. SPEC §14: must be configurable,
	 * never hard-coded. Defaults to `DEFAULT_WATCHDOG_INTERVAL_MS`.
	 */
	watchdogIntervalMs?: number;
	/**
	 * How long LLM generation activity may be absent in `LLM_GENERATING` before a
	 * probable stall is recorded. Defaults to `DEFAULT_LLM_IDLE_THRESHOLD_MS`.
	 */
	llmIdleThresholdMs?: number;
	/**
	 * Whether a probable stall may trigger minimal wake-up steering.
	 * Defaults to true. Turning it off leaves Step 4 pure-observation behaviour.
	 */
	steeringEnabled?: boolean;
	/**
	 * Minimum spacing between steering attempts. Defaults to
	 * `DEFAULT_STEERING_COOLDOWN_MS`.
	 */
	steeringCooldownMs?: number;
	/**
	 * Hard cap on steering attempts per Worker run. Defaults to
	 * `DEFAULT_MAX_STEERING_COUNT` (1).
	 */
	maxSteeringCount?: number;
	/**
	 * Overall wall-clock budget for one Worker run. Defaults to
	 * `DEFAULT_WORKER_TIMEOUT_MS`.
	 *
	 * This is a Harness-level liveness boundary, not a Worker instruction. It is
	 * activity-blind: LLM output, tool execution, turn changes and steering never
	 * reset it.
	 */
	workerTimeoutMs?: number;
	/**
	 * How long the harness waits for the underlying AgentSession to wind down
	 * after the run is already terminal, before disposing it and releasing the
	 * single Worker slot. Defaults to `DEFAULT_DRAIN_GRACE_MS`.
	 */
	drainGraceMs?: number;
	/**
	 * Injectable clock/timer seam shared by the state tracker, watchdog, timeout
	 * guard and drain wait, so all of them advance together under a virtual clock.
	 * Defaults to the system scheduler.
	 */
	timerScheduler?: TimerScheduler;
	/**
	 * Injectable Git CLI seam for workspace evidence. Defaults to the real `git`
	 * binary via `systemGitRunner`.
	 */
	gitRunner?: GitRunner;
	/**
	 * Files larger than this are compared by byte size instead of content hash,
	 * so evidence collection never reads a large untracked artifact.
	 * Defaults to `DEFAULT_MAX_HASH_BYTES`.
	 */
	maxHashBytes?: number;
	/** Cap on retained patch text. Truncation is reported structurally. */
	maxPatchBytes?: number;
	/**
	 * Skip workspace evidence entirely. The result then carries
	 * `verificationStatus: "unavailable"` with an explicit reason rather than an
	 * empty change list, so "not observed" never looks like "nothing changed".
	 */
	disableWorkspaceEvidence?: boolean;
	/**
	 * Bound on validation-command execution during verification.
	 *
	 * Independent of `workerTimeoutMs`: verification runs after the Worker has
	 * already terminated, so the Worker's deadline is spent and irrelevant here.
	 * Always finite.
	 */
	verificationCommandTimeoutMs?: number;
	/**
	 * Injectable validation-command seam. Defaults to `spawnCommandRunner`
	 * (argv-based, no shell).
	 */
	commandRunner?: CommandRunner;
	/** Cap on retained validation-command output. */
	maxCommandOutputBytes?: number;
	/**
	 * Gate policy. Defaults to `DEFAULT_GATE_POLICY`, which requires both
	 * completed execution and satisfied verification.
	 *
	 * Injected rather than hard-coded at the call site so the Gate is demonstrably
	 * policy-driven. Not a rule language: two booleans, no expressions.
	 */
	gatePolicy?: GatePolicy;
}

/**
 * The subset of pi's `AgentSession` that the harness actually touches.
 *
 * Declared narrowly so unit tests can supply a stand-in without reimplementing
 * the whole class, while the conformance test guarantees this stays a true
 * subset of the real API.
 */
export interface WorkerSession {
	readonly state: {
		readonly errorMessage?: string;
		/** Authoritative set of in-flight tool call ids. */
		readonly pendingToolCalls: ReadonlySet<string>;
	};
	readonly messages: readonly unknown[];
	subscribe(listener: AgentSessionEventListener): () => void;
	prompt(text: string): Promise<void>;
	waitForIdle(): Promise<void>;
	abort(): Promise<void>;
	/**
	 * Native pi steering. Queues into the agent steering queue
	 * (`AgentSession.steer` -> `_queueSteer`). Only meaningful while a run is
	 * active; on an idle session the message is never consumed.
	 */
	steer(text: string): Promise<void>;
	/**
	 * Native pi user message. Always triggers a turn when the session is idle;
	 * `deliverAs: "steer"` controls queueing while streaming.
	 */
	sendUserMessage(text: string, options?: { deliverAs?: "steer" | "followUp" }): Promise<void>;
	dispose(): void;
	getLastAssistantText(): string | undefined;
	/** Native pi: whether an agent run is currently active. */
	readonly isStreaming: boolean;
}

/**
 * Worker run status.
 *
 * Explicit 1:1 mapping from the terminal cause decided by the arbiter
 * (SPEC Step 6 §17). TIMEOUT is its own status and is never folded into `error`.
 */
export type WorkerStatus = "completed" | "error" | "aborted" | "timeout";

export interface WorkerBoundaryInfo {
	/** Whether the TaskSpec work type is read-only. */
	readOnly: boolean;
	/** Tool calls blocked before execution. */
	violations: readonly BoundaryViolation[];
}

/** Structured result returned to the Architect (SPEC v0.1 §18, minimal subset). */
export interface WorkerResult {
	taskId: string;
	status: WorkerStatus;
	/** Worker's final assistant text, returned as-is. No summarization or truncation yet. */
	finalResponse: string;
	/** Error description, or null when the Worker did not fail. */
	error: string | null;
	/** Normalized lifecycle state at the end of the run. */
	finalState: WorkerState;
	/** Work-boundary enforcement report. */
	boundary: WorkerBoundaryInfo;
	/** Watchdog observations. Never changes `status` by itself. */
	watchdog: WorkerWatchdogInfo;
	/** Steering interventions taken during this run. */
	steering: WorkerSteeringInfo;
	/**
	 * Liveness-boundary diagnostics. Always present.
	 *
	 * `timedOut` is false on every non-timeout path, so the caller can tell
	 * "timeout was configured but did not fire" from "timeout fired".
	 */
	timeout: WorkerTimeoutInfo;
	/**
	 * Deterministic workspace-change evidence, produced independently of the
	 * Worker's own report.
	 *
	 * Present for every terminal cause, including TIMEOUT and ABORTED, where
	 * partial changes may exist. `verificationStatus` distinguishes "observed,
	 * nothing changed" from "could not observe": an empty `changedFiles` is only
	 * proof of no change when the status is `available`.
	 *
	 * This is evidence, not a verdict — nothing here says whether the Worker was
	 * correct.
	 */
	workspaceEvidence?: WorkspaceEvidence;
	/**
	 * Deterministic completion verification (Step 8).
	 *
	 * Compares the TaskSpec's structured `completionChecks` against the
	 * workspace evidence and any validation command results. It is a summary of
	 * the VERIFICATION PROCESS, not a verdict on the Worker: `unsatisfied` means
	 * an explicitly stated condition was not observed, and `unverifiable` means
	 * nothing was machine-checkable.
	 *
	 * Independent of `status`. `completed` + `unsatisfied` and `timeout` +
	 * `satisfied` are both valid combinations.
	 */
	verification?: VerificationEvidence;
	/**
	 * Deterministic Gate decision (Step 9).
	 *
	 * The Gate reads only two already-established facts — `status` and
	 * `verification.state` — and assigns a policy outcome. It is not a verdict on
	 * the Worker: `reject` means "the policy was not satisfied", and `inspect`
	 * means "the evidence does not support an automatic decision".
	 *
	 * This field never changes `status`. `completed` + `reject` is a normal,
	 * meaningful combination: the Worker terminated cleanly and the policy still
	 * declined to accept the result automatically.
	 */
	gate?: GateEvidence;
	/**
	 * Lifecycle action selected from the Gate decision (Step 10).
	 *
	 * Carries only the decision. The evidence it was derived from stays as
	 * siblings on this same WorkerResult — `status`, `workspaceEvidence`,
	 * `verification`, `gate` — so nothing is duplicated and nothing is
	 * discarded. Embedding the WorkerResult inside its own field was avoided
	 * deliberately: it would make the result unserialisable.
	 */
	orchestration?: OrchestrationDecision;
}

/**
 * Watchdog diagnostics attached to the Worker result.
 *
 * A probable stall is an observation, not a terminal Worker status: the Worker
 * may keep running and still complete normally.
 */
export interface WorkerWatchdogInfo {
	stallDetected: boolean;
	events: readonly WorkerStallEvent[];
	intervalMs: number;
	llmIdleThresholdMs: number;
}

/**
 * Steering diagnostics attached to the Worker result.
 *
 * Every decision is recorded, including the ones that did nothing, so a caller
 * can tell "no stall happened" from "stall happened but steering was suppressed".
 * No boolean hides the behaviour.
 */
export interface WorkerSteeringInfo {
	/** True when at least one steering message was actually dispatched. */
	steeringPerformed: boolean;
	/** Number of steering attempts (successful or failed). */
	attempts: number;
	maxSteeringCount: number;
	cooldownMs: number;
	/** True when the run wanted to steer more than the budget allowed. */
	budgetExhausted: boolean;
	events: readonly WorkerSteeringEvent[];
}

/** Thrown when the configured provider/model cannot be resolved. Never retried. */
export class WorkerModelResolutionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkerModelResolutionError";
	}
}

/** Live view of the currently running Worker. Internal: no Architect-facing poll API yet. */
export interface ActiveWorkerView {
	taskId: string;
	workType: WorkType;
	state: WorkerState;
	pendingToolCalls: number;
	blockedCalls: number;
}

/**
 * Owns the lifecycle of one Worker AgentSession at a time.
 *
 * The harness is deliberately dumb in v0: no retry, no timeout, no diff
 * analysis. It creates an isolated session, normalizes the native lifecycle into
 * `WorkerState`, enforces the TaskSpec work boundary at the tool-call level, runs
 * a read-only watchdog alongside the Worker, waits for `agent_settled`, and
 * normalizes the outcome.
 *
 * Separation of concerns, enforced by types:
 *   AgentSession -> WorkerStateTracker -> WorkerWatchdog -> StallEvent
 *                                            |
 *                                            v
 *                                     SteeringController -> session.steer(".")
 *
 * The watchdog never sees the session and cannot intervene. The
 * `SteeringController` sees only a read-only probe and a two-method actuator, so
 * it cannot abort, prompt, or escalate.
 */
export class WorkerHarness {
	private activeTaskId: string | null = null;
	private activeTracker: WorkerStateTracker | undefined;
	private activeRecorder: BoundaryRecorder | undefined;
	private activeWatchdog: WorkerWatchdog | undefined;
	private activeStallEvents: WorkerStallEvent[] = [];
	private activeSteering: SteeringController | undefined;
	private activeSteeringEvents: WorkerSteeringEvent[] = [];
	private activeArbiter: TerminalArbiter | undefined;
	private activeTimeoutGuard: WorkerTimeoutGuard | undefined;
	private activeTimeoutInfo: WorkerTimeoutInfo | undefined;

	public constructor(private readonly config: WorkerHarnessConfig) {}

	/** Resolved watchdog interval (config override, else shipped default). */
	public get watchdogIntervalMs(): number {
		return this.config.watchdogIntervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS;
	}

	/** Resolved LLM idle threshold (config override, else shipped default). */
	public get llmIdleThresholdMs(): number {
		return this.config.llmIdleThresholdMs ?? DEFAULT_LLM_IDLE_THRESHOLD_MS;
	}

	/** Resolved steering cooldown (config override, else shipped default). */
	public get steeringCooldownMs(): number {
		return this.config.steeringCooldownMs ?? DEFAULT_STEERING_COOLDOWN_MS;
	}

	/** Resolved per-run steering budget (config override, else shipped default). */
	public get maxSteeringCount(): number {
		return this.config.maxSteeringCount ?? DEFAULT_MAX_STEERING_COUNT;
	}

	/** Whether stall-triggered steering is enabled for this harness. */
	public get steeringEnabled(): boolean {
		return this.config.steeringEnabled !== false;
	}

	/** Resolved overall Worker timeout (config override, else shipped default). */
	public get workerTimeoutMs(): number {
		return this.config.workerTimeoutMs ?? DEFAULT_WORKER_TIMEOUT_MS;
	}

	/** Resolved drain grace (config override, else shipped default). */
	public get drainGraceMs(): number {
		return this.config.drainGraceMs ?? DEFAULT_DRAIN_GRACE_MS;
	}

	/** True while a Worker occupies the single v0 slot. */
	public get isBusy(): boolean {
		return this.activeTaskId !== null;
	}

	public get activeTask(): string | null {
		return this.activeTaskId;
	}

	/**
	 * Narrow internal view of the live Worker. Returns null when no Worker is
	 * running. Intended for the harness itself, tests and debugging — not an
	 * Architect-facing polling tool (that is a later step).
	 */
	public get activeWorker(): ActiveWorkerView | null {
		if (!this.activeTracker || this.activeTaskId === null) {
			return null;
		}
		const snapshot = this.activeTracker.snapshot();
		return {
			taskId: this.activeTaskId,
			workType: this.activeWorkType,
			state: snapshot.state,
			pendingToolCalls: snapshot.pendingToolCalls,
			blockedCalls: this.activeRecorder?.count ?? 0,
		};
	}

	private activeWorkType: WorkType = "implement";

	/**
	 * Run a TaskSpec to its settled state.
	 *
	 * Never throws for expected failures: everything comes back as a
	 * `WorkerResult` so the Architect session cannot be crashed by a Worker.
	 */
	public async run(spec: TaskSpec, signal?: AbortSignal): Promise<WorkerResult> {
		if (this.activeTaskId !== null) {
			return this.plainResult(spec, "error", "", {
				error:
					`Worker is busy with task "${this.activeTaskId}". ` +
					"pi-local-worker v0 allows exactly one Worker at a time.",
			});
		}

		this.activeTaskId = spec.taskId;
		this.activeWorkType = spec.workType;
		this.activeStallEvents = [];
		try {
			return await this.runExclusive(spec, signal);
		} catch (error) {
			return this.plainResult(spec, "error", "", {
				error: `Unexpected Worker failure: ${errorMessage(error)}`,
			});
		} finally {
			this.activeTaskId = null;
			this.activeTracker = undefined;
			this.activeRecorder = undefined;
			this.activeStallEvents = [];
		}
	}

	/**
	 * Runs the Worker, then verifies — in that order, with teardown between.
	 *
	 * Verification deliberately runs AFTER the session is disposed and the
	 * workspace has settled, so no in-flight Worker activity can move the tree
	 * under the observation. It runs BEFORE the N=1 slot is released (the caller
	 * releases it in its own `finally`), so no second Worker can modify the same
	 * workspace while these checks are in progress.
	 *
	 * Validation commands therefore execute against a quiescent repository with
	 * no live Worker session. That is the safe ordering: verify a stable
	 * workspace, not one still being written.
	 */
	private async runExclusive(spec: TaskSpec, signal?: AbortSignal): Promise<WorkerResult> {
		const result = await this.runAndCollect(spec, signal);
		const verified = this.verify(spec, result);
		// Gate last: it consumes facts that already exist, so it runs after both
		// the workspace observation and verification are complete, and before the
		// N=1 slot is released. It is pure and cheap — no I/O, no subprocess.
		const gated = this.gate(verified);
		// Orchestration runs after the Gate and still inside the N=1 slot.
		//
		// It is pure and needs no Worker resource, so the slot could technically be
		// released before it. Keeping the ordering anyway means the slot is held for
		// the whole lifecycle — execute -> observe -> verify -> gate -> orchestrate
		// — so no second Worker can start while the first one's outcome is still
		// undecided. That is the safer invariant and costs nothing measurable.
		return this.orchestrate(gated);
	}

	private async runAndCollect(spec: TaskSpec, signal?: AbortSignal): Promise<WorkerResult> {
		let session: WorkerSession | undefined;
		let tracker: WorkerStateTracker | undefined;
		const recorder = new BoundaryRecorder();
		let agentEndMessages: readonly unknown[] = [];
		let unsubscribeEvents: (() => void) | undefined;
		let removeAbortListener: (() => void) | undefined;
		let timeoutGuard: WorkerTimeoutGuard | undefined;
		let settleError: string | undefined;

		try {
			if (signal?.aborted) {
				return this.plainResult(spec, "aborted", "", {
					error: "Aborted before the Worker could start.",
				});
			}

			const options = await this.buildSessionOptions(spec, recorder);
			const createSession = this.config.createSession ?? createAgentSession;

			// SPEC §24: nothing is armed before the session exists, so a creation
			// failure cannot leak a timeout timer, a watchdog interval or an
			// AbortSignal listener, and is never classified as TIMEOUT.
			try {
				const created = await createSession(options);
				session = created.session;
			} catch (error) {
				return this.plainResult(spec, "error", "", {
					error: `Worker session creation failed: ${errorMessage(error)}`,
				});
			}

			// Baseline is captured here, after the session exists and before any
			// execution machinery is armed and before the prompt. The invariant is
			// that Worker-generated changes are never part of the baseline.
			//
			// A baseline failure does NOT fail the Worker: it only makes the
			// evidence unavailable, and that is reported as such.
			let baseline: GitSnapshot | undefined;
			let baselineError: string | undefined;
			if (!this.config.disableWorkspaceEvidence) {
				try {
					baseline = this.createGitObserver().capture();
				} catch (error) {
					baselineError = errorMessage(error);
				}
			}

			// One scheduler, one clock, shared by the tracker, the watchdog, the
			// timeout guard and the drain wait, so a virtual clock moves the whole
			// system together.
			const scheduler = this.config.timerScheduler ?? createSystemTimerScheduler();
			const stallEvents: WorkerStallEvent[] = [];
			this.activeStallEvents = stallEvents;

			// The single point where this run's fate is decided. Nothing else may
			// set the terminal outcome (SPEC §10).
			const arbiter = new TerminalArbiter(() => scheduler.now());
			this.activeArbiter = arbiter;

			// The state tracker observes the native lifecycle. `pendingToolCalls` is
			// the authoritative tool signal; it is already updated by pi before any
			// listener runs, so reading it inside `tool_execution_end` is correct.
			const activeTracker = new WorkerStateTracker({
				getPendingToolCalls: () => session?.state.pendingToolCalls.size ?? 0,
				isAborted: () => signal?.aborted === true,
				now: () => scheduler.now(),
			});
			tracker = activeTracker;
			this.activeTracker = activeTracker;
			this.activeRecorder = recorder;

			// The watchdog only ever sees a read-only probe. It has no reference to
			// the session, so it cannot steer, message or abort.
			const watchdog = new WorkerWatchdog({
				taskId: spec.taskId,
				scheduler,
				intervalMs: this.watchdogIntervalMs,
				llmIdleThresholdMs: this.llmIdleThresholdMs,
				probe: () => {
					const snap = activeTracker.snapshot();
					return {
						state: snap.state,
						turnId: snap.turnId,
						lastLlmActivityAt: snap.lastLlmActivityAt,
						pendingToolCalls: snap.pendingToolCalls,
					};
				},
				onStall: (event) => {
					stallEvents.push(event);
					void activeSteering?.request(event);
				},
			});
			this.activeWatchdog = watchdog;

			// The steering controller gets a two-method actuator, not the
			// session: `abort` and `prompt` are structurally unavailable to it.
			const activeSteering = new SteeringController({
				taskId: spec.taskId,
				policy: {
					cooldownMs: this.steeringCooldownMs,
					maxSteeringCount: this.maxSteeringCount,
				},
				now: () => scheduler.now(),
				probe: () => {
					const snap = activeTracker.snapshot();
					return {
						state: snap.state,
						turnId: snap.turnId,
						pendingToolCalls: snap.pendingToolCalls,
						isStreaming: session?.isStreaming ?? false,
					};
				},
				actuator: {
					steer: async (message) => {
						await session?.steer(message);
					},
					wakeIdle: async (message) => {
						await session?.sendUserMessage(message, { deliverAs: "steer" });
					},
				},
				onEvent: (event) => this.activeSteeringEvents.push(event),
			});
			activeSteering.enabled = this.steeringEnabled;
			this.activeSteering = activeSteering;

			unsubscribeEvents = session.subscribe((event: AgentSessionEvent) => {
				const before = activeTracker.state;
				const after = activeTracker.handle(event);
				if (after !== before) {
					this.config.onStateChange?.(activeTracker.snapshot());
				}
				if (event.type === "agent_end") {
					agentEndMessages = event.messages;
				}
				if (isTerminalWorkerState(after)) {
					// Native lifecycle reached a terminal state: shut the observers
					// down immediately (SPEC §14/§15). The *result* is still
					// decided by the settle path, which has the richer
					// classification (stop reason, errorMessage, settled flag);
					// this listener must not pre-empt it with a coarser one.
					activeSteering.markTerminal();
					watchdog.stop();
				}
			});
			watchdog.start();

			if (signal) {
				const onAbort = () => {
					// Cooperative request, deliberately NOT awaited: pi's
					// `AgentSession.abort()` awaits `waitForIdle()`, which is
					// unbounded for a non-cooperative session (SPEC §13).
					void session?.abort().catch(() => {
						/* best-effort; the arbiter already decided ABORTED */
					});
					// The harness does not depend on that cooperation.
					activeSteering.markTerminal();
					watchdog.stop();
					arbiter.decide("ABORTED", "external AbortSignal fired");
				};
				signal.addEventListener("abort", onAbort);
				removeAbortListener = () => signal.removeEventListener("abort", onAbort);
			}

			// The timeout starts here: the session exists and the prompt is about
			// to run. Pre-session setup is excluded (SPEC §5).
			timeoutGuard = new WorkerTimeoutGuard({
				timeoutMs: this.workerTimeoutMs,
				scheduler,
				onTimeout: () => {
					// Harness-level terminal marking. No fake pi event is invented.
					activeTracker.markTerminal("TIMEOUT");
					watchdog.stop();
					activeSteering.markTerminal();
					// Cooperative wind-down request only. It is NOT what makes
					// worker_run return; the arbiter is.
					void session?.abort().catch(() => {
						/* best-effort */
					});
					arbiter.decide(
						"TIMEOUT",
						`Worker exceeded the ${this.workerTimeoutMs}ms overall run budget`,
					);
				},
			});
			timeoutGuard.start(scheduler.now());
			this.activeTimeoutGuard = timeoutGuard;

			// The settle path runs concurrently but never gates the return: if it
			// hangs, the timeout arbiter still resolves the run.
			const settleTarget = session;
			void (async () => {
				try {
					await settleTarget.prompt(renderTaskSpecPrompt(spec));
				} catch (error) {
					settleError = `Worker execution failed: ${errorMessage(error)}`;
					arbiter.decide("ERROR", settleError);
					return;
				}
				await settleTarget.waitForIdle();
				const outcome = this.classifySettled(activeTracker, settleTarget, agentEndMessages, signal);
				arbiter.decide(outcome.cause, outcome.reason ?? "Worker settled normally.");
			})().catch((error) => {
				settleError = `Worker settle path failed: ${errorMessage(error)}`;
				arbiter.decide("ERROR", settleError);
			});

			// The only await that matters. Guaranteed to resolve because the
			// timeout timer is always armed while the run is live.
			await arbiter.wait();

			// Terminal won. Bounded wind-down before the slot is released.
			const sessionDrained = await this.drainSession(settleTarget, scheduler);
			const timeoutInfo = timeoutGuard.info(sessionDrained, this.drainGraceMs);
			this.activeTimeoutInfo = timeoutInfo;

			// Final workspace observation happens AFTER the drain, so a cooperative
			// teardown cannot race the Git read, and BEFORE the slot is released,
			// so no second Worker can touch the same workspace concurrently.
			//
			// Collected for every terminal cause: a TIMEOUT or ABORTED run may
			// still have produced partial changes worth evidencing.
			const workspaceEvidence = this.collectEvidence(baseline, baselineError, sessionDrained);

			return this.resultFromArbiter(
				spec,
				settleTarget,
				recorder,
				arbiter,
				timeoutInfo,
				settleError,
				workspaceEvidence,
			);
		} finally {
			// SPEC §20: every terminal path tears everything down.
			timeoutGuard?.stop();
			this.activeTimeoutGuard = undefined;
			this.activeWatchdog?.stop();
			this.activeWatchdog = undefined;
			// Lock steering, then let any in-flight steering call finish before the
			// session goes away, so every decision is recorded and no dispatch
			// races the dispose.
			this.activeSteering?.markTerminal();
			try {
				await this.activeSteering?.drain();
			} catch {
				// Steering failures are already recorded as events; they must not
				// change the Worker outcome.
			}
			removeAbortListener?.();
			unsubscribeEvents?.();
			session?.dispose();
		}
	}

	/**
	 * Bounded wait for the underlying AgentSession to stop streaming.
	 *
	 * Never unbounded: the grace timer wins if the session is non-cooperative, so
	 * `worker_run` cannot be held open by a Worker that ignores the abort signal.
	 * The grace timer is always unscheduled before returning.
	 */
	private async drainSession(session: WorkerSession, scheduler: TimerScheduler): Promise<boolean> {
		if (!session.isStreaming) {
			return true;
		}
		let handle: TimerHandle | undefined;
		const graceElapsed = new Promise<boolean>((resolve) => {
			handle = scheduler.scheduleOnce(() => resolve(false), this.drainGraceMs);
		});
		const idleFirst = await Promise.race([
			session
				.waitForIdle()
				.then(() => true)
				.catch(() => false),
			graceElapsed,
		]);
		if (handle) {
			scheduler.unschedule(handle);
		}
		return idleFirst && !session.isStreaming;
	}

	/**
	 * Classify a session that settled on its own, using the Step 3 normalized
	 * state plus the native stop reason.
	 *
	 * Returns a machine-readable cause and a human-readable reason. The reason is
	 * `null` only for a clean finish; every other branch carries the specific
	 * diagnosis so the result never hides behind a generic string.
	 */
	private classifySettled(
		tracker: WorkerStateTracker,
		session: WorkerSession,
		agentEndMessages: readonly unknown[],
		signal?: AbortSignal,
	): { cause: TerminalCause; reason: string | null } {
		const messages = agentEndMessages.length > 0 ? agentEndMessages : session.messages;
		const stopReason = lastAssistantStopReason(messages);
		const stateErrorMessage = session.state.errorMessage;

		if (signal?.aborted || stopReason === "aborted") {
			return { cause: "ABORTED", reason: stateErrorMessage ?? "Worker was aborted." };
		}
		if (stopReason === "error" || stateErrorMessage) {
			return {
				cause: "ERROR",
				reason: stateErrorMessage ?? "Worker ended with an error stop reason.",
			};
		}
		if (!tracker.snapshot().settled) {
			return { cause: "ERROR", reason: "Worker never reached agent_settled." };
		}
		if (stopReason === undefined) {
			return { cause: "ERROR", reason: "Worker produced no assistant message." };
		}
		return { cause: "FINISHED", reason: null };
	}

	/** Build the result from the arbiter's winning cause. */
	private resultFromArbiter(
		spec: TaskSpec,
		session: WorkerSession,
		recorder: BoundaryRecorder,
		arbiter: TerminalArbiter,
		timeoutInfo: WorkerTimeoutInfo,
		settleError?: string,
		workspaceEvidence?: WorkspaceEvidence,
	): WorkerResult {
		const cause = arbiter.cause ?? "ERROR";
		const error =
			cause === "FINISHED"
				? null
				: (settleError ?? arbiter.decision?.reason ?? `Worker run ended as ${cause}.`);
		return {
			taskId: spec.taskId,
			status: workerStatusForCause(cause),
			finalResponse: session.getLastAssistantText() ?? "",
			error,
			finalState: cause,
			boundary: {
				readOnly: isReadOnlyWorkType(spec.workType),
				violations: [...recorder.violations],
			},
			watchdog: this.buildWatchdogInfo(),
			steering: this.buildSteeringInfo(),
			timeout: timeoutInfo,
			...(workspaceEvidence ? { workspaceEvidence } : {}),
		};
	}

	private createGitObserver(): GitObserver {
		return new GitObserver({
			cwd: this.config.cwd,
			runner: this.config.gitRunner,
			maxHashBytes: this.config.maxHashBytes,
		});
	}

	/**
	 * Produce the final workspace observation.
	 *
	 * Never throws and never changes the Worker result's status. A Git failure is
	 * an evidence failure, not a Worker failure: the Worker may have completed
	 * perfectly while the observation could not be performed.
	 */
	private collectEvidence(
		baseline: GitSnapshot | undefined,
		baselineError: string | undefined,
		sessionDrained: boolean,
	): WorkspaceEvidence {
		if (this.config.disableWorkspaceEvidence) {
			return {
				verificationStatus: "unavailable",
				capturedAt: Date.now(),
				changedFiles: [],
				diffStat: [],
				workerDiffStat: [],
				errors: ["Workspace evidence is disabled on this harness."],
				limitations: ["No workspace observation was performed."],
			};
		}

		const evidence = collectWorkspaceEvidence({
			cwd: this.config.cwd,
			baseline,
			baselineError,
			runner: this.config.gitRunner,
			maxHashBytes: this.config.maxHashBytes,
			maxPatchBytes: this.config.maxPatchBytes,
		});

		if (!sessionDrained) {
			// The drain timed out, so a still-running tool could in principle modify
			// the workspace after this observation. Report the limitation rather
			// than pretending the evidence is settled.
			return {
				...evidence,
				limitations: [
					...evidence.limitations,
					"Session did not drain within the grace period; a still-running tool may modify the workspace after this observation.",
				],
			};
		}
		return evidence;
	}

	/**
	 * Run deterministic completion verification against the collected result.
	 *
	 * Observational only: this never changes `status`, never retries, never steers,
	 * and never touches the repository. Runs for every terminal cause — a timed
	 * out or aborted run may still have produced work that satisfies an explicit
	 * requirement, and that observation is worth reporting even though the run
	 * itself did not complete.
	 */
	private verify(spec: TaskSpec, result: WorkerResult): WorkerResult {
		const { requirements, notes } = deriveRequirements(spec);

		const evidence = verifyRequirements({
			requirements,
			workspaceEvidence: result.workspaceEvidence,
			runner: this.config.commandRunner ?? spawnCommandRunner,
			cwd: this.config.cwd,
			commandTimeoutMs:
				this.config.verificationCommandTimeoutMs ?? DEFAULT_VERIFICATION_COMMAND_TIMEOUT_MS,
			maxOutputBytes: this.config.maxCommandOutputBytes,
			notes,
		});

		return { ...result, verification: evidence };
	}

	/**
	 * Apply the Gate policy to the finished result.
	 *
	 * Reads only `status` and `verification.state`. It cannot reach the Worker,
	 * the filesystem, Git, a subprocess or a model — the Gate has no capability
	 * to do so, which is what keeps the information flow one-way.
	 *
	 * Never changes `status` or `verification`.
	 */
	private gate(result: WorkerResult): WorkerResult {
		const gate = evaluateGate(
			{ status: result.status, verification: result.verification },
			this.config.gatePolicy ?? DEFAULT_GATE_POLICY,
		);
		return { ...result, gate };
	}

	/**
	 * Selects the lifecycle action from the Gate decision that already exists.
	 *
	 * Deliberately reads `result.gate` rather than re-deriving anything: the
	 * Orchestrator consumes the Gate's conclusion, it does not recompute it. A
	 * missing Gate is a sequencing bug, not a state to route around, so it throws
	 * rather than silently inventing an action.
	 */
	private orchestrate(result: WorkerResult): WorkerResult {
		if (!result.gate) {
			throw new Error("orchestration requires a Gate decision; gate() must run first");
		}
		return { ...result, orchestration: orchestrate({ gate: result.gate }) };
	}

	/**
	 * Evidence for runs that never reached a session (aborted before start,
	 * session-creation failure). Nothing was observed, so nothing can be claimed.
	 */
	private noBaselineEvidence(): WorkspaceEvidence {
		return {
			verificationStatus: "unavailable",
			capturedAt: Date.now(),
			changedFiles: [],
			diffStat: [],
			workerDiffStat: [],
			errors: ["No baseline was captured: the run ended before a Worker session existed."],
			limitations: ["No workspace observation was performed."],
		};
	}

	/**
	 * Build the options that make the Worker session independent.
	 *
	 * - `SessionManager.inMemory()`  -> no history from the Architect, no persistence
	 * - `noExtensions: true`         -> recursion guard: pi-local-worker is never
	 *                                   loaded inside its own Worker
	 * - `extensionFactories`         -> the work-boundary extension only. Inline
	 *                                   factories still load under
	 *                                   `noExtensions: true` (verified in
	 *                                   resource-loader.ts), which is what gives
	 *                                   us the native `tool_call` veto inside the
	 *                                   Worker without recursive extension loading.
	 *
	 * Project instruction files (AGENTS.md) and skills stay enabled: SPEC §9 allows
	 * normal pi behaviour for project instructions, and the built-in coding tools
	 * stay available because the Worker needs them.
	 */
	private async buildSessionOptions(
		spec: TaskSpec,
		recorder: BoundaryRecorder,
	): Promise<CreateAgentSessionOptions> {
		const cwd = this.config.cwd;
		const agentDir = this.config.agentDir ?? getAgentDir();

		const settingsManager = SettingsManager.create(cwd, agentDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			noExtensions: true,
			extensionFactories: [
				{ name: "pi-local-worker-boundary", factory: createWorkBoundaryExtension(spec.workType, recorder) },
			],
		});
		await resourceLoader.reload();

		const options: CreateAgentSessionOptions = {
			cwd,
			agentDir,
			settingsManager,
			resourceLoader,
			sessionManager: SessionManager.inMemory(cwd),
		};

		if (this.config.thinkingLevel) {
			options.thinkingLevel = this.config.thinkingLevel;
		}

		if (this.config.provider && this.config.modelId) {
			const modelRuntime =
				this.config.modelRuntime ??
				(await ModelRuntime.create({
					authPath: join(agentDir, "auth.json"),
					modelsPath: join(agentDir, "models.json"),
				}));

			const model = modelRuntime.getModel(this.config.provider, this.config.modelId);
			if (!model) {
				throw new WorkerModelResolutionError(
					`Worker model "${this.config.provider}/${this.config.modelId}" is not available in the pi model catalog.`,
				);
			}
			options.model = model;
		}

		return options;
	}

	/** Assemble a WorkerResult with the current boundary + normalized-state context. */
	private plainResult(
		spec: TaskSpec,
		status: WorkerStatus,
		finalResponse: string,
		extra: {
			error?: string | null;
			tracker?: WorkerStateTracker;
			recorder?: BoundaryRecorder;
			stallEvents?: readonly WorkerStallEvent[];
		} = {},
	): WorkerResult {
		const activeRecorder = extra.recorder ?? this.activeRecorder;
		const stallEvents = extra.stallEvents ?? this.activeStallEvents;
		return {
			taskId: spec.taskId,
			status,
			finalResponse,
			error: extra.error ?? null,
			finalState: extra.tracker?.snapshot().state ?? "INITIALIZING",
			boundary: {
				readOnly: isReadOnlyWorkType(spec.workType),
				violations: activeRecorder ? [...activeRecorder.violations] : [],
			},
			watchdog: this.buildWatchdogInfo(stallEvents),
			steering: this.buildSteeringInfo(),
			timeout: this.activeTimeoutInfo ?? this.notTriggeredTimeoutInfo(),
			// These paths never reached a session, so no baseline was captured and
			// nothing was observed. Report that explicitly rather than leaving the
			// field absent or implying an empty change set.
			workspaceEvidence: this.noBaselineEvidence(),
		};
	}

	private buildWatchdogInfo(
		stallEvents: readonly WorkerStallEvent[] = this.activeStallEvents,
	): WorkerWatchdogInfo {
		return {
			stallDetected: stallEvents.length > 0,
			events: [...stallEvents],
			intervalMs: this.watchdogIntervalMs,
			llmIdleThresholdMs: this.llmIdleThresholdMs,
		};
	}

	/**
	 * Timeout info for paths where no timeout guard was ever armed (setup
	 * failure, pre-start abort). Present but explicitly not triggered.
	 */
	private notTriggeredTimeoutInfo(): WorkerTimeoutInfo {
		return {
			timedOut: false,
			timeoutMs: this.workerTimeoutMs,
			startedAt: 0,
			deadlineAt: 0,
			detectedAt: 0,
			elapsedMs: 0,
			drainGraceMs: this.drainGraceMs,
			sessionDrained: true,
		};
	}

	private buildSteeringInfo(): WorkerSteeringInfo {
		const events = this.activeSteering?.steeringEvents ?? this.activeSteeringEvents;
		const steeringPerformed = events.some((event) => event.outcome === "steered");
		const attempts = this.activeSteering?.attemptsMade ?? events.filter((e) => e.attempts > 0).length;
		return {
			steeringPerformed,
			attempts,
			maxSteeringCount: this.maxSteeringCount,
			cooldownMs: this.steeringCooldownMs,
			budgetExhausted: events.some((event) => event.outcome === "suppressed_budget"),
			events: [...events],
		};
	}
}

/**
 * Explicit terminal-cause -> status mapping (SPEC Step 6 §17).
 * TIMEOUT is its own status and is never folded into `error`.
 */
export function workerStatusForCause(cause: TerminalCause): WorkerStatus {
	switch (cause) {
		case "FINISHED":
			return "completed";
		case "ERROR":
			return "error";
		case "ABORTED":
			return "aborted";
		case "TIMEOUT":
			return "timeout";
	}
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}
