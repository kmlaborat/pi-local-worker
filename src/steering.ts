import type { WorkerState } from "./worker-state.ts";
import type { WorkerStallEvent } from "./watchdog.ts";

/**
 * The entire intervention. SPEC Step 5 §5: the steering message is exactly `"."`.
 *
 * Not "Continue.", not "Wake up.", not generated text. The point of v0 is to
 * find out whether a single minimal token is enough to break a generation stall.
 */
export const STEERING_MESSAGE = ".";

/** Conservative shipped defaults (SPEC Step 5 §8: do not choose a large value). */
export const DEFAULT_STEERING_COOLDOWN_MS = 30_000;
export const DEFAULT_MAX_STEERING_COUNT = 1;

/**
 * Which native pi call was used.
 *
 * Verified against pi 0.85.1 source (`core/agent-session.ts`):
 * - `steer()` -> `_queueUserInput(..., "steer")` -> `_queueSteer()`. Queues into
 *   the agent's steering queue. If the agent loop is not running the message is
 *   never consumed, so this is only correct while a run is active.
 * - `sendUserMessage(text, { deliverAs: "steer" })` -> `prompt(text,
 *   { streamingBehavior: "steer", source: "extension" })`. When the session is
 *   NOT streaming this takes the full prompt path and *starts a turn*, which is
 *   what an idle Worker needs. When it IS streaming it queues as steering.
 */
export type SteeringMethod = "steer" | "idle-wake";

export type SteeringOutcome =
	/** The steering message was dispatched successfully. */
	| "steered"
	/** The native call threw or rejected. */
	| "failed"
	/** A previous steering action is still inside the cooldown window. */
	| "suppressed_cooldown"
	/** The per-run steering budget is exhausted. */
	| "suppressed_budget"
	/** Worker is in a terminal state; the terminal state wins. */
	| "skipped_terminal"
	/** A tool is in flight; silence is expected, steering is unsafe. */
	| "skipped_tool_active"
	/** Normalized state is not a steering-eligible state. */
	| "skipped_not_eligible"
	/**
	 * State changed between the policy decision and the dispatch.
	 *
	 * Distinct from the plain guards so a race is never mistaken for a
	 * policy-based suppression.
	 */
	| "skipped_race";

/**
 * Structured record of one steering *decision*.
 *
 * Separate from `WorkerStallEvent` on purpose: a stall is an observation, a
 * steering event is an intervention. The stall event is never mutated to imply
 * that steering happened.
 */
export interface WorkerSteeringEvent {
	taskId: string;
	/** Turn the decision was made in. */
	turnId: number;
	/** Normalized Worker state at decision time. */
	state: WorkerState;
	/** Clock time of the decision. */
	requestedAt: number;
	/** Which native call was used, or null when nothing was sent. */
	method: SteeringMethod | null;
	/** The dispatched message, or null when nothing was sent. Always `.` when set. */
	message: string | null;
	outcome: SteeringOutcome;
	/** Steering attempts made so far in this run, including this one if attempted. */
	attempts: number;
	maxSteeringCount: number;
	/** Idle time reported by the triggering stall event, for correlation. */
	idleMs: number;
	/** Authoritative in-flight tool count at decision time. */
	pendingToolCalls: number;
	reason: string;
	/** Present when `outcome === "failed"`. */
	error?: string;
}

/**
 * Read-only view the steering controller needs.
 *
 * `isStreaming` is a native pi fact (`session.isStreaming`), not a second state
 * machine: the normalized `state` decides *whether* to intervene, `isStreaming`
 * decides *which native call is safe* to use.
 */
export interface SteeringProbe {
	readonly state: WorkerState;
	readonly turnId: number;
	readonly pendingToolCalls: number;
	/** Native `session.isStreaming` — whether an agent run is currently active. */
	readonly isStreaming: boolean;
}

/**
 * The only way the steering controller can touch the Worker.
 *
 * Deliberately narrower than `AgentSession`: no `abort`, no state mutation, no
 * prompt. The controller cannot escalate.
 */
export interface SteeringActuator {
	/** Active generation: `session.steer(".")`. */
	steer(message: string): Promise<void>;
	/** Idle Worker: `session.sendUserMessage(".", { deliverAs: "steer" })`. */
	wakeIdle(message: string): Promise<void>;
}

export interface SteeringPolicy {
	/** Minimum spacing between steering attempts. */
	cooldownMs: number;
	/** Hard cap on steering attempts per Worker run. */
	maxSteeringCount: number;
}

export interface SteeringControllerOptions {
	taskId: string;
	policy: SteeringPolicy;
	now: () => number;
	probe: () => SteeringProbe;
	actuator: SteeringActuator;
	onEvent?: (event: WorkerSteeringEvent) => void;
	/** Set false to keep pure Step 4 observation behaviour. Defaults to true. */
	enabled?: boolean;
}

const TERMINAL_STATES: ReadonlySet<WorkerState> = new Set<WorkerState>([
	"FINISHED",
	"ERROR",
	"ABORTED",
	"TIMEOUT",
]);

export function isTerminalWorkerState(state: WorkerState): boolean {
	return TERMINAL_STATES.has(state);
}

/**
 * Maps the Step 3 normalized state to the intervention method.
 *
 * Only two states are eligible. Everything else is explicitly not a steering
 * candidate, so no new state can silently become steerable.
 */
export function steeringMethodForState(state: WorkerState): SteeringMethod | undefined {
	switch (state) {
		// Actively generating: interrupt the current generation.
		case "LLM_GENERATING":
			return "steer";
		// Between lifecycle events: a queued steer would never be consumed, so
		// wake the session instead.
		case "WAITING_FOR_LLM":
			return "idle-wake";
		default:
			return undefined;
	}
}

/**
 * Decides and performs minimal wake-up steering.
 *
 * The Watchdog stays a pure observer; this class is the only thing in the system
 * that acts on a stall. It owns cooldown and budget, and it re-checks live Worker
 * state immediately before dispatch so a stall observed against a since-changed
 * Worker never produces a stray message.
 *
 * It can never make a Worker terminal: failures are recorded, not propagated.
 */
export class SteeringController {
	private attempts = 0;
	private lastSteeringAt: number | undefined;
	private terminal = false;
	private readonly eventsList: WorkerSteeringEvent[] = [];
	/** Serializes requests so two concurrent stalls cannot both pass the budget check. */
	private chain: Promise<void> = Promise.resolve();

	/** Toggle intervention on/off. Disabled => every request is refused. */
	public enabled = true;

	public constructor(private readonly options: SteeringControllerOptions) {
		this.enabled = options.enabled ?? true;
	}

	public get steeringEvents(): readonly WorkerSteeringEvent[] {
		return this.eventsList;
	}

	public get attemptsMade(): number {
		return this.attempts;
	}

	public get isTerminal(): boolean {
		return this.terminal;
	}

	/**
	 * Called when the Worker reaches a terminal state. Any later request is
	 * refused outright — nothing may be enqueued after `agent_settled`.
	 */
	public markTerminal(): void {
		this.terminal = true;
	}

	/**
	 * Evaluate one stall event and, if permitted, steer.
	 *
	 * Never rejects: a steering failure is recorded as an event.
	 */
	public request(stall: WorkerStallEvent): Promise<WorkerSteeringEvent> {
		let settle!: (event: WorkerSteeringEvent) => void;
		const promise = new Promise<WorkerSteeringEvent>((resolve) => {
			settle = resolve;
		});
		this.chain = this.chain.then(async () => {
			settle(await this.dispatch(stall));
		});
		return promise;
	}

	/** Await every steering action issued so far (deterministic test shutdown). */
	public drain(): Promise<void> {
		return this.chain;
	}

	private async dispatch(stall: WorkerStallEvent): Promise<WorkerSteeringEvent> {
		const requestedAt = this.options.now();
		const probe = this.options.probe();

		// Reads the probe again at record time so the event reflects the state the
		// decision was actually made against, not the one read on entry.
		const build = (
			outcome: SteeringOutcome,
			method: SteeringMethod | null,
			message: string | null,
			reason: string,
			error?: string,
		): WorkerSteeringEvent => {
			const at = this.options.probe();
			return {
				taskId: this.options.taskId,
				turnId: at.turnId,
				state: at.state,
				requestedAt,
				method,
				message,
				outcome,
				attempts: this.attempts,
				maxSteeringCount: this.options.policy.maxSteeringCount,
				idleMs: stall.idleMs,
				pendingToolCalls: at.pendingToolCalls,
				reason,
				...(error === undefined ? {} : { error }),
			};
		};

		const record = (event: WorkerSteeringEvent): WorkerSteeringEvent => {
			this.eventsList.push(event);
			this.options.onEvent?.(event);
			return event;
		};

		// 0. Disabled: no intervention at all, but the refusal is still recorded so
		//    "steering off" is distinguishable from "no stall happened".
		if (!this.enabled) {
			return record(
				build("skipped_not_eligible", null, null, "Steering is disabled for this Worker run."),
			);
		}

		// 1. Terminal safety. The terminal state always wins.
		if (this.terminal || isTerminalWorkerState(probe.state)) {
			return record(
				build(
					"skipped_terminal",
					null,
					null,
					`Worker state is ${probe.state}; steering is not allowed after the Worker settled.`,
				),
			);
		}

		// 2. Tool safety. Never steer while a tool is executing, even if the stall
		//    event is stale.
		if (probe.pendingToolCalls > 0) {
			return record(
				build(
					"skipped_tool_active",
					null,
					null,
					`${probe.pendingToolCalls} tool call(s) in flight; silence is expected, steering suppressed.`,
				),
			);
		}

		// 3. Eligibility from the Step 3 normalized state.
		const method = steeringMethodForState(probe.state);
		if (!method) {
			return record(
				build(
					"skipped_not_eligible",
					null,
					null,
					`Worker state ${probe.state} is not a steering target.`,
				),
			);
		}

		// 4. Cooldown. Protects against a rapid intervention loop; deliberately
		//    independent of Step 4 stall-episode dedup, which allows a fresh
		//    episode as soon as activity resumes.
		const { cooldownMs, maxSteeringCount } = this.options.policy;
		if (this.lastSteeringAt !== undefined && requestedAt - this.lastSteeringAt < cooldownMs) {
			return record(
				build(
					"suppressed_cooldown",
					null,
					null,
					`Last steering action was ${requestedAt - this.lastSteeringAt}ms ago ` +
						`(cooldown ${cooldownMs}ms).`,
				),
			);
		}

		// 5. Budget. Exhaustion is recorded, never escalated to abort or timeout.
		if (this.attempts >= maxSteeringCount) {
			return record(
				build(
					"suppressed_budget",
					null,
					null,
					`Steering budget exhausted (${this.attempts}/${maxSteeringCount}).`,
				),
			);
		}

		// 6. Race guard: re-read live state immediately before dispatch.
		//    The state at stall-detection time is not assumed to still hold.
		const live = this.options.probe();
		if (this.terminal || isTerminalWorkerState(live.state)) {
			return record(
				build(
					"skipped_terminal",
					null,
					null,
					`Worker reached ${live.state} between stall detection and dispatch.`,
				),
			);
		}
		if (live.pendingToolCalls > 0) {
			return record(
				build(
					"skipped_tool_active",
					null,
					null,
					`A tool started between stall detection and dispatch (${live.pendingToolCalls} in flight).`,
				),
			);
		}
		if (method === "steer" && !live.isStreaming) {
			// `session.steer()` on a non-running session only enqueues; the
			// message would never be delivered. Refuse rather than dead-letter it.
			return record(
				build(
					"skipped_race",
					null,
					null,
					"Session is no longer streaming; a queued steer would never be delivered.",
				),
			);
		}

		// 7. Dispatch. Attempt counted up front so a failure still consumes budget
		//    and starts the cooldown — a throwing steering API must not be retried
		//    every tick.
		this.attempts += 1;
		this.lastSteeringAt = requestedAt;

		try {
			if (method === "steer") {
				await this.options.actuator.steer(STEERING_MESSAGE);
			} else {
				await this.options.actuator.wakeIdle(STEERING_MESSAGE);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return record(
				build(
					"failed",
					method,
					STEERING_MESSAGE,
					`Steering via ${method} threw; the Worker was left untouched and keeps running.`,
					message,
				),
			);
		}

		return record(
			build(
				"steered",
				method,
				STEERING_MESSAGE,
				`Sent minimal wake-up ${JSON.stringify(STEERING_MESSAGE)} via ${method}.`,
			),
		);
	}
}
