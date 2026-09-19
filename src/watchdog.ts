import { createSystemTimerScheduler, type TimerHandle, type TimerScheduler } from "./timer.ts";
import type { WorkerState } from "./worker-state.ts";

/**
 * Read-only view of what the watchdog is allowed to see.
 *
 * Deliberately narrow: the watchdog never receives the AgentSession, so it is
 * structurally incapable of steering, messaging or aborting the Worker.
 */
export interface StallProbe {
	readonly state: WorkerState;
	readonly turnId: number;
	readonly lastLlmActivityAt: number | undefined;
	readonly pendingToolCalls: number;
}

/** Structured, machine-readable "probable stall" diagnostic (SPEC v0.1 §12). */
export interface WorkerStallEvent {
	taskId: string;
	/** Turn in which the stall was observed (0 if no turn started). */
	turnId: number;
	/** Normalized Worker state at detection time. */
	state: WorkerState;
	/** Wall-clock time the watchdog made the determination. */
	detectedAt: number;
	/** Timestamp of the last observed LLM generation activity. */
	lastActivityAt: number | undefined;
	/** `detectedAt - lastActivityAt`. */
	idleMs: number;
	/** Authoritative in-flight tool count at detection time. */
	pendingToolCalls: number;
	/** Human-readable explanation. Never the only signal. */
	reason: string;
}

/**
 * Time/timer seam.
 *
 * Step 4 introduced this as a watchdog-private abstraction; Step 6 promoted it to
 * `src/timer.ts` because the Worker timeout and the post-abort drain wait need
 * the same virtual clock. The old names are kept as aliases so Step 4 call sites
 * and tests stay valid.
 */
export type WatchdogTimerHandle = TimerHandle;
export type WatchdogScheduler = TimerScheduler;
export const createSystemWatchdogScheduler = createSystemTimerScheduler;

/** SPEC §14: thresholds must be configurable; these are the shipped defaults. */
export const DEFAULT_WATCHDOG_INTERVAL_MS = 5_000;
export const DEFAULT_LLM_IDLE_THRESHOLD_MS = 30_000;

export interface WorkerWatchdogOptions {
	taskId: string;
	scheduler: WatchdogScheduler;
	intervalMs: number;
	llmIdleThresholdMs: number;
	/** Read-only observation of the Worker. */
	probe: () => StallProbe;
	/** Called at most once per stall episode. */
	onStall: (event: WorkerStallEvent) => void;
}

/**
 * Observes the normalized Worker state and reports *probable* LLM stalls.
 *
 * It cannot prove the LLM is hung; it only records that LLM generation activity
 * has been absent longer than the configured threshold while the Worker is in
 * `LLM_GENERATING`.
 *
 * Tool-aware: while a tool is in flight the Worker is expected to produce no LLM
 * output, so `TOOL_EXECUTING` (or any non-zero `pendingToolCalls`) never counts
 * as an LLM stall, no matter how long it lasts.
 *
 * `WAITING_FOR_LLM` is deliberately not a stall candidate: the Worker can
 * legitimately wait between lifecycle transitions, and Step 4 keeps the detector
 * conservative.
 *
 * This class performs no intervention of any kind.
 */
export class WorkerWatchdog {
	private running = false;
	private handle: WatchdogTimerHandle | undefined;
	/**
	 * Identity of the stall episode already reported: the same turn plus the same
	 * last-activity timestamp means the same ongoing stall.
	 */
	private reportedEpisode: { turnId: number; activityAt: number } | undefined;

	public constructor(private readonly options: WorkerWatchdogOptions) {}

	public get isRunning(): boolean {
		return this.running;
	}

	public start(): void {
		if (this.running) {
			return;
		}
		this.running = true;
		this.handle = this.options.scheduler.scheduleRepeating(
			() => this.check(),
			this.options.intervalMs,
		);
	}

	/** Idempotent. Guarantees no timer is left behind. */
	public stop(): void {
		this.running = false;
		if (this.handle) {
			this.options.scheduler.unschedule(this.handle);
			this.handle = undefined;
		}
	}

	/**
	 * One evaluation. Returns the event it produced, or undefined.
	 *
	 * Exposed so tests (and the harness shutdown path) can drive a single
	 * deterministic check without waiting for the interval.
	 */
	public check(): WorkerStallEvent | undefined {
		if (!this.running) {
			return undefined;
		}

		const probe = this.options.probe();
		const detectedAt = this.options.scheduler.now();

		// Only active generation can stall. Everything else — including
		// WAITING_FOR_LLM, TURN_COMPLETED and terminal states — is left alone,
		// and any open episode is closed so a later stall reports fresh.
		if (probe.state !== "LLM_GENERATING") {
			this.reportedEpisode = undefined;
			return undefined;
		}

		// Belt-and-braces tool awareness on top of the state check: a tool in
		// flight means silence is expected (SPEC INV-4).
		if (probe.pendingToolCalls > 0) {
			this.reportedEpisode = undefined;
			return undefined;
		}

		if (probe.lastLlmActivityAt === undefined) {
			return undefined;
		}

		const idleMs = detectedAt - probe.lastLlmActivityAt;
		if (idleMs <= this.options.llmIdleThresholdMs) {
			// Activity resumed within the threshold: close the episode so a later
			// quiet period can be reported as a new stall.
			this.reportedEpisode = undefined;
			return undefined;
		}

		const episode = { turnId: probe.turnId, activityAt: probe.lastLlmActivityAt };
		if (
			this.reportedEpisode &&
			this.reportedEpisode.turnId === episode.turnId &&
			this.reportedEpisode.activityAt === episode.activityAt
		) {
			// Same ongoing stall: already reported.
			return undefined;
		}
		this.reportedEpisode = episode;

		const event: WorkerStallEvent = {
			taskId: this.options.taskId,
			turnId: probe.turnId,
			state: probe.state,
			detectedAt,
			lastActivityAt: probe.lastLlmActivityAt,
			idleMs,
			pendingToolCalls: probe.pendingToolCalls,
			reason:
				`No LLM generation activity for ${idleMs}ms ` +
				`(threshold ${this.options.llmIdleThresholdMs}ms) while state was LLM_GENERATING. ` +
				"Probable stall; no intervention taken.",
		};

		this.options.onStall(event);
		return event;
	}
}
