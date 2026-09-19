import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

/**
 * Normalized Worker state (SPEC v0.1 §10).
 *
 * This is an observation layer over pi's native AgentSession lifecycle. It does
 * not drive anything: pi drives, the tracker records.
 */
export type WorkerState =
	/** Worker session is being created; execution has not started. */
	| "INITIALIZING"
	/** Worker active: no tool running, waiting for the next LLM activity. */
	| "WAITING_FOR_LLM"
	/** Receiving assistant generation updates. */
	| "LLM_GENERATING"
	/** `session.state.pendingToolCalls.size > 0`. */
	| "TOOL_EXECUTING"
	/** A `turn_end` was observed. Not the same as the Task being finished. */
	| "TURN_COMPLETED"
	/** `agent_settled` observed and the run ended normally. */
	| "FINISHED"
	/** `agent_settled` observed and the run ended with an error. */
	| "ERROR"
	/** `agent_settled` observed after an abort. */
	| "ABORTED"
	/** Reserved for Step 6. Never produced by this tracker. */
	| "TIMEOUT";

const TERMINAL_STATES: readonly WorkerState[] = ["FINISHED", "ERROR", "ABORTED", "TIMEOUT"];

export interface WorkerStateTransition {
	from: WorkerState;
	to: WorkerState;
	/** Native pi event that caused the transition. */
	event: string;
}

export interface WorkerStateSnapshot {
	state: WorkerState;
	/** Authoritative active-tool count at the moment of the snapshot. */
	pendingToolCalls: number;
	agentStartSeen: boolean;
	agentEndSeen: boolean;
	willRetryAfterAgentEnd: boolean;
	settled: boolean;
	/**
	 * 1-based turn counter, incremented on every `turn_start`.
	 * Lets activity be attributed to a specific turn (0 = no turn started yet).
	 */
	turnId: number;
	/**
	 * Timestamp of the most recent LLM generation activity in the current turn.
	 *
	 * Set on `turn_start` (fresh per-turn baseline), assistant `message_start`
	 * and assistant `message_update`. Never set by user messages, tool-result
	 * messages, custom messages or tool lifecycle events.
	 */
	lastLlmActivityAt: number | undefined;
	transitions: readonly WorkerStateTransition[];
}

export interface WorkerStateSources {
	/**
	 * Authoritative count of in-flight tool calls.
	 * Wired to `session.state.pendingToolCalls.size`.
	 */
	getPendingToolCalls: () => number;
	/** Whether an abort has been requested from outside the Worker. */
	isAborted?: () => boolean;
	/** Injectable clock. Defaults to `Date.now`. */
	now?: () => number;
}

/**
 * Normalizes native AgentSession events into `WorkerState`.
 *
 * Invariants:
 *   agent_settled -> FINISHED (or ERROR / ABORTED)
 *   turn_end      -> TURN_COMPLETED
 *   pendingToolCalls.size > 0 -> TOOL_EXECUTING
 *
 * `agent_end` alone never produces a terminal state, because pi may retry or
 * continue after it.
 */
export class WorkerStateTracker {
	private _state: WorkerState = "INITIALIZING";
	private _agentStartSeen = false;
	private _agentEndSeen = false;
	private _willRetryAfterAgentEnd = false;
	private _settled = false;
	private _lastAssistantStopReason: string | undefined;
	private _turnId = 0;
	private _lastLlmActivityAt: number | undefined;
	private _transitions: WorkerStateTransition[] = [];

	public constructor(private readonly sources: WorkerStateSources) {}

	public get state(): WorkerState {
		return this._state;
	}

	public get pendingToolCalls(): number {
		return this.sources.getPendingToolCalls();
	}

	public get turnId(): number {
		return this._turnId;
	}

	public get lastLlmActivityAt(): number | undefined {
		return this._lastLlmActivityAt;
	}

	public snapshot(): WorkerStateSnapshot {
		return {
			state: this._state,
			pendingToolCalls: this.pendingToolCalls,
			agentStartSeen: this._agentStartSeen,
			agentEndSeen: this._agentEndSeen,
			willRetryAfterAgentEnd: this._willRetryAfterAgentEnd,
			settled: this._settled,
			turnId: this._turnId,
			lastLlmActivityAt: this._lastLlmActivityAt,
			transitions: [...this._transitions],
		};
	}

	/** Feed one native event. Returns the state after handling. */
	public handle(event: AgentSessionEvent): WorkerState {
		switch (event.type) {
			case "agent_start":
				this._agentStartSeen = true;
				this.transition("WAITING_FOR_LLM", "agent_start");
				break;

			case "turn_start":
				// Turn-aware reset: a new turn never inherits the previous turn's
				// activity timestamp, so stale activity cannot keep the watchdog
				// believing the new turn is healthy.
				this._turnId += 1;
				this._lastLlmActivityAt = this.now();
				this.transition("WAITING_FOR_LLM", "turn_start");
				break;

			case "message_start":
				if (messageRole(event.message) === "assistant") {
					// Establishes the baseline for this response. Without it a
					// response that produces no updates would have no timestamp
					// at all inside the turn.
					this._lastLlmActivityAt = this.now();
					this.transition("LLM_GENERATING", "message_start:assistant");
				}
				break;

			case "message_update":
				if (messageRole(event.message) === "assistant") {
					// Primary LLM generation-activity signal: streamed content.
					this._lastLlmActivityAt = this.now();
					this.transition("LLM_GENERATING", "message_update:assistant");
				}
				break;

			case "message_end": {
				// Only assistant messages mean generation. User, toolResult and
				// custom messages must not move the state into LLM_GENERATING.
				if (messageRole(event.message) !== "assistant") break;
				this._lastAssistantStopReason = stopReasonOf(event.message);
				// A tool batch may already be in flight when the assistant message ends.
				if (this.pendingToolCalls > 0) {
					this.transition("TOOL_EXECUTING", "message_end:assistant+tools");
				}
				break;
			}

			case "tool_execution_start":
				this.transition("TOOL_EXECUTING", "tool_execution_start");
				break;

			case "tool_execution_update":
				this.transition("TOOL_EXECUTING", "tool_execution_update");
				break;

			case "tool_execution_end":
				// Re-read the authoritative set: parallel batches keep other ids in flight.
				if (this.pendingToolCalls > 0) {
					// Recorded even though the state value is unchanged: the watchdog
					// needs to see that a tool finished while others are still running.
					this.transition("TOOL_EXECUTING", "tool_execution_end:still-busy", true);
				} else {
					this.transition("WAITING_FOR_LLM", "tool_execution_end:idle");
				}
				break;

			case "turn_end":
				if (messageRole(event.message) === "assistant") {
					this._lastAssistantStopReason = stopReasonOf(event.message);
				}
				this.transition("TURN_COMPLETED", "turn_end");
				break;

			case "agent_end":
				// Never terminal here: pi may retry or continue.
				this._agentEndSeen = true;
				this._willRetryAfterAgentEnd = event.willRetry === true;
				if (this._willRetryAfterAgentEnd) {
					this.transition("WAITING_FOR_LLM", "agent_end:willRetry");
				}
				break;

			case "auto_retry_start":
				this.transition("WAITING_FOR_LLM", "auto_retry_start");
				break;

			case "agent_settled":
				this._settled = true;
				this.transition(this.classifyTerminal(), "agent_settled");
				break;

			default:
				break;
		}

		return this._state;
	}

	/**
	 * Harness-level terminal marking.
	 *
	 * `TIMEOUT` is not a native pi lifecycle event and no fake pi event is
	 * invented to produce it. The tracker is told, by the harness, that the run is
	 * over. Native lifecycle transitions after this are ignored, exactly as they
	 * are after a native terminal state, so a late `agent_settled` can never
	 * overwrite TIMEOUT.
	 */
	public markTerminal(state: "TIMEOUT"): WorkerState {
		this.transition(state, "harness:timeout");
		return this._state;
	}

	private classifyTerminal(): WorkerState {
		if (this.sources.isAborted?.() || this._lastAssistantStopReason === "aborted") {
			return "ABORTED";
		}
		if (this._lastAssistantStopReason === "error") {
			return "ERROR";
		}
		return "FINISHED";
	}

	private now(): number {
		return this.sources.now?.() ?? Date.now();
	}

	private transition(to: WorkerState, event: string, recordSelfTransition = false): void {
		if (TERMINAL_STATES.includes(this._state)) {
			return;
		}
		if (to === this._state && !recordSelfTransition) {
			return;
		}
		this._transitions.push({ from: this._state, to, event });
		this._state = to;
	}
}

/**
 * Read the stop reason off the last assistant message without importing pi's
 * message types (they are not re-exported from the package root).
 */
export function lastAssistantStopReason(messages: readonly unknown[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as { role?: unknown; stopReason?: unknown } | undefined;
		if (message && message.role === "assistant") {
			return typeof message.stopReason === "string" ? message.stopReason : undefined;
		}
	}
	return undefined;
}

function messageRole(message: unknown): string | undefined {
	const role = (message as { role?: unknown } | undefined)?.role;
	return typeof role === "string" ? role : undefined;
}

function stopReasonOf(message: unknown): string | undefined {
	const reason = (message as { stopReason?: unknown } | undefined)?.stopReason;
	return typeof reason === "string" ? reason : undefined;
}
