import type { TimerHandle, TimerScheduler } from "../../src/timer.ts";

interface VirtualTimer {
	id: number;
	callback: () => void;
	/** undefined means one-shot. */
	intervalMs: number | undefined;
	nextAt: number;
}

/**
 * Deterministic clock + timer scheduler.
 *
 * Nothing fires until `advance()` is called, so tests never sleep against the
 * wall clock and can step over any number of intervals in one call.
 *
 * `advance()` keeps firing timers that come due while walking toward the target,
 * which lets a test drive a whole scenario (watchdog ticks, a timeout deadline
 * armed during that walk, and a drain-grace timer armed by the timeout) with a
 * single call.
 */
export class VirtualWatchdogScheduler implements TimerScheduler {
	private timers: VirtualTimer[] = [];
	private nextId = 1;
	public scheduleCount = 0;
	public unscheduleCount = 0;
	/** Every callback that fired, in order, for assertions. */
	public readonly firedKinds: string[] = [];

	public constructor(private current = 1_000_000) {}

	public now(): number {
		return this.current;
	}

	public scheduleRepeating(callback: () => void, intervalMs: number): TimerHandle {
		const id = this.nextId++;
		this.timers.push({ id, callback, intervalMs, nextAt: this.current + intervalMs });
		this.scheduleCount += 1;
		return { kind: "interval", ref: id };
	}

	public scheduleOnce(callback: () => void, delayMs: number): TimerHandle {
		const id = this.nextId++;
		this.timers.push({ id, callback, intervalMs: undefined, nextAt: this.current + delayMs });
		this.scheduleCount += 1;
		return { kind: "timeout", ref: id };
	}

	public unschedule(handle: TimerHandle): void {
		const id = handle.ref as number;
		const before = this.timers.length;
		this.timers = this.timers.filter((timer) => timer.id !== id);
		if (this.timers.length !== before) {
			this.unscheduleCount += 1;
		}
	}

	/** Number of timers still registered. */
	public get liveTimerCount(): number {
		return this.timers.length;
	}

	/** Move the virtual clock forward, firing everything that comes due. */
	public advance(ms: number): void {
		const target = this.current + ms;
		for (;;) {
			const due = this.timers
				.filter((timer) => timer.nextAt <= target)
				.sort((a, b) => a.nextAt - b.nextAt)[0];
			if (!due) break;
			this.current = due.nextAt;
			if (due.intervalMs === undefined) {
				this.timers = this.timers.filter((timer) => timer.id !== due.id);
				this.firedKinds.push("timeout");
			} else {
				due.nextAt = this.current + due.intervalMs;
				this.firedKinds.push("interval");
			}
			due.callback();
		}
		this.current = target;
	}
}

/** Alias: the seam is no longer watchdog-specific. */
export const VirtualTimerScheduler = VirtualWatchdogScheduler;
