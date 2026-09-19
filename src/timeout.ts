import type { TimerHandle, TimerScheduler } from "./timer.ts";

/**
 * Shipped default for the overall Worker budget.
 *
 * Ten minutes: long enough for a real multi-file implementation task with a slow
 * model, short enough that a wedged Worker cannot hold the single v0 slot
 * indefinitely. The value matters far less than the fact that it is finite,
 * explicit and configurable (SPEC Step 6 §3).
 */
export const DEFAULT_WORKER_TIMEOUT_MS = 10 * 60_000;

/**
 * How long the harness lets the underlying AgentSession wind down after the run
 * has already been decided terminal, before it disposes the session and releases
 * the single Worker slot.
 *
 * pi's `AgentSession.abort()` is cooperative and `dispose()` aborts the agent,
 * retry, compaction and bash controllers without awaiting them. The grace window
 * gives that cooperative teardown a chance to actually land before a new Worker
 * may occupy the slot, which is what preserves the N=1 isolation invariant.
 */
export const DEFAULT_DRAIN_GRACE_MS = 5_000;

/** Structured timeout diagnostics (SPEC Step 6 §18). */
export interface WorkerTimeoutInfo {
	/** True once the deadline fired (or was already past). */
	timedOut: boolean;
	/** Configured overall budget. */
	timeoutMs: number;
	/** Clock time the budget started (session created, prompt about to run). */
	startedAt: number;
	/** `startedAt + timeoutMs`. */
	deadlineAt: number;
	/** Clock time the timeout was observed; 0 when it never fired. */
	detectedAt: number;
	/** Elapsed time at observation. */
	elapsedMs: number;
	/** Grace allowed for the underlying session to wind down. */
	drainGraceMs: number;
	/**
	 * Whether the underlying AgentSession actually reached idle within the grace
	 * window. False means the cooperative abort did not land in time and the
	 * harness disposed a still-active session.
	 */
	sessionDrained: boolean;
}

export interface WorkerTimeoutGuardOptions {
	timeoutMs: number;
	scheduler: TimerScheduler;
	/** Called exactly once when the deadline expires. */
	onTimeout: (info: { startedAt: number; deadlineAt: number; firedAt: number }) => void;
}

/**
 * Arms the overall Worker deadline and fires exactly once.
 *
 * Deliberately activity-blind: nothing in this class reads Worker state, LLM
 * output, tool activity or steering. The deadline is absolute (SPEC §6).
 */
export class WorkerTimeoutGuard {
	private handle: TimerHandle | undefined;
	private _startedAt = 0;
	private _deadlineAt = 0;
	private _firedAt: number | undefined;
	private _fired = false;

	public constructor(private readonly options: WorkerTimeoutGuardOptions) {}

	public get startedAt(): number {
		return this._startedAt;
	}

	public get deadlineAt(): number {
		return this._deadlineAt;
	}

	public get fired(): boolean {
		return this._fired;
	}

	public get isArmed(): boolean {
		return this.handle !== undefined;
	}

	/** Arm the deadline. Idempotent: a second call is ignored. */
	public start(startedAt = this.options.scheduler.now()): void {
		if (this.handle) {
			return;
		}
		this._startedAt = startedAt;
		this._deadlineAt = startedAt + this.options.timeoutMs;
		this.handle = this.options.scheduler.scheduleOnce(() => {
			this._fired = true;
			this._firedAt = this.options.scheduler.now();
			this.handle = undefined;
			this.options.onTimeout({
				startedAt: this._startedAt,
				deadlineAt: this._deadlineAt,
				firedAt: this._firedAt,
			});
		}, this.options.timeoutMs);
	}

	/** Disarm. Idempotent; never fires the callback. */
	public stop(): void {
		if (this.handle) {
			this.options.scheduler.unschedule(this.handle);
			this.handle = undefined;
		}
	}

	/** Snapshot for the result. `detectedAt` is 0 when the timeout never fired. */
	public info(sessionDrained: boolean, drainGraceMs: number): WorkerTimeoutInfo {
		const now = this.options.scheduler.now();
		const detectedAt = this._firedAt ?? 0;
		return {
			timedOut: this._fired,
			timeoutMs: this.options.timeoutMs,
			startedAt: this._startedAt,
			deadlineAt: this._deadlineAt,
			detectedAt,
			elapsedMs: (detectedAt || now) - this._startedAt,
			drainGraceMs,
			sessionDrained,
		};
	}
}
