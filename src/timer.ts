/**
 * Unified clock + timer seam.
 *
 * Every time-dependent component in the harness (state tracker, watchdog, worker
 * timeout, drain wait) shares ONE scheduler instance, so a virtual clock drives
 * the whole system deterministically.
 *
 * Two timer kinds are genuinely needed:
 *   - repeating  -> the watchdog's periodic evaluation
 *   - one-shot   -> the Worker timeout deadline and the post-abort drain grace
 * Collapsing them into one method would hide which is which at every call site.
 */
export type TimerKind = "interval" | "timeout";

export interface TimerHandle {
	readonly kind: TimerKind;
	readonly ref: unknown;
}

export interface TimerScheduler {
	now(): number;
	scheduleRepeating(callback: () => void, intervalMs: number): TimerHandle;
	scheduleOnce(callback: () => void, delayMs: number): TimerHandle;
	unschedule(handle: TimerHandle): void;
}

/** Production scheduler backed by `setInterval` / `setTimeout`. */
export function createSystemTimerScheduler(): TimerScheduler {
	return {
		now: () => Date.now(),
		scheduleRepeating: (callback, intervalMs) => ({
			kind: "interval" as const,
			ref: setInterval(callback, intervalMs),
		}),
		scheduleOnce: (callback, delayMs) => ({
			kind: "timeout" as const,
			ref: setTimeout(callback, delayMs),
		}),
		unschedule: (handle) => {
			if (handle.kind === "interval") {
				clearInterval(handle.ref as NodeJS.Timeout);
			} else {
				clearTimeout(handle.ref as NodeJS.Timeout);
			}
		},
	};
}
