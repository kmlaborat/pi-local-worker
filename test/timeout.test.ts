import { describe, expect, test } from "vitest";

import type { TaskSpec } from "../src/task-spec.ts";
import { TerminalArbiter } from "../src/terminal-arbiter.ts";
import { WorkerHarness, type WorkerHarnessConfig } from "../src/worker-harness.ts";
import { FakeWorkerSession } from "./helpers/fake-session.ts";
import { VirtualWatchdogScheduler } from "./helpers/virtual-clock.ts";

const TIMEOUT = 5_000;
const GRACE = 1_000;
/** Watchdog deliberately quiet here: Step 6 is about the deadline, not stalls. */
const WATCHDOG_INTERVAL = 100_000;

function spec(overrides: Partial<TaskSpec> = {}): TaskSpec {
	return {
		taskId: "s6-task",
		goal: "timeout test",
		scope: [],
		workType: "implement",
		completionCriteria: ["done"],
		...overrides,
	};
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

async function tick(times = 4) {
	for (let i = 0; i < times; i++) {
		await new Promise((r) => setTimeout(r, 0));
	}
}

function makeHarness(
	fake: FakeWorkerSession,
	scheduler: VirtualWatchdogScheduler,
	extra: Partial<WorkerHarnessConfig> = {},
): WorkerHarness {
	return new WorkerHarness({
		cwd: process.cwd(),
		timerScheduler: scheduler,
		watchdogIntervalMs: WATCHDOG_INTERVAL,
		workerTimeoutMs: TIMEOUT,
		drainGraceMs: GRACE,
		createSession: async () => ({ session: fake as never }),
		...extra,
	});
}

/**
 * Drive the virtual clock in small steps until the run resolves.
 *
 * Robust to microtask ordering without depending on it: the harness arms the
 * drain-grace timer some ticks after the deadline fires, and this keeps stepping
 * until the run is actually done. No wall-clock sleep is involved — `tick()` only
 * yields the event loop.
 */
async function driveUntilDone<T>(
	run: Promise<T>,
	scheduler: VirtualWatchdogScheduler,
	maxVirtualMs = 30_000,
): Promise<T> {
	let done = false;
	void run.then(
		() => {
			done = true;
		},
		() => {
			done = true;
		},
	);
	const step = 250;
	for (let elapsed = 0; elapsed < maxVirtualMs && !done; elapsed += step) {
		scheduler.advance(step);
		await tick();
	}
	return run;
}

/** Convenience: cross the deadline and keep driving until the run returns. */
function settleAfterDeadline<T>(run: Promise<T>, scheduler: VirtualWatchdogScheduler): Promise<T> {
	return driveUntilDone(run, scheduler);
}

// ---------------------------------------------------------------------------
// Unit: the arbiter latch itself.
// ---------------------------------------------------------------------------

describe("TerminalArbiter", () => {
	test("first decision wins and is immutable", () => {
		const arbiter = new TerminalArbiter(() => 100);
		expect(arbiter.decide("TIMEOUT", "deadline")).toBe(true);
		expect(arbiter.decide("FINISHED", "late settle")).toBe(false);
		expect(arbiter.cause).toBe("TIMEOUT");
		expect(arbiter.decision?.reason).toBe("deadline");
		expect(arbiter.lost).toHaveLength(1);
		expect(arbiter.lost[0]!.cause).toBe("FINISHED");
	});

	test("wait() resolves immediately when already decided", async () => {
		const arbiter = new TerminalArbiter(() => 1);
		arbiter.decide("ABORTED", "signal");
		await expect(arbiter.wait()).resolves.toMatchObject({ cause: "ABORTED" });
	});

	test("wait() resolves when a later decide() lands", async () => {
		const arbiter = new TerminalArbiter(() => 1);
		const waiting = arbiter.wait();
		arbiter.decide("ERROR", "boom");
		await expect(waiting).resolves.toMatchObject({ cause: "ERROR", reason: "boom" });
	});
});

// ---------------------------------------------------------------------------
// A / J: normal completion before the deadline.
// ---------------------------------------------------------------------------

describe("Step 6 — A/J: completion before timeout", () => {
	test("a Worker that settles in time completes normally", async () => {
		const scheduler = new VirtualWatchdogScheduler();
		const fake = new FakeWorkerSession();
		const result = await makeHarness(fake, scheduler).run(spec());

		expect(result.status).toBe("completed");
		expect(result.finalState).toBe("FINISHED");
		expect(result.error).toBeNull();
		expect(result.timeout.timedOut).toBe(false);
		expect(result.timeout.timeoutMs).toBe(TIMEOUT);
		expect(result.timeout.detectedAt).toBe(0);
		expect(result.timeout.sessionDrained).toBe(true);
		expect(scheduler.liveTimerCount).toBe(0);
	});

	test("settling just before the deadline still wins over the timeout", async () => {
		const gate = deferred();
		const scheduler = new VirtualWatchdogScheduler();
		const fake = new FakeWorkerSession({ gateAfterLlmActivity: gate.promise });
		const running = makeHarness(fake, scheduler).run(spec());
		await tick();

		// Resolve the Worker just before the deadline, then cross it.
		gate.resolve();
		scheduler.advance(TIMEOUT - 1);
		await tick();
		scheduler.advance(TIMEOUT);
		const result = await running;

		expect(result.status).toBe("completed");
		expect(result.finalState).toBe("FINISHED");
		expect(result.timeout.timedOut).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// B / C / E: timeout while generating, activity does not reset the deadline.
// ---------------------------------------------------------------------------

describe("Step 6 — B/C/E: timeout is activity-blind", () => {
	test("a Worker that never settles times out", async () => {
		const gate = deferred();
		const scheduler = new VirtualWatchdogScheduler();
		const fake = new FakeWorkerSession({ gateAfterLlmActivity: gate.promise });
		const running = makeHarness(fake, scheduler).run(spec());
		await tick();

		const result = await settleAfterDeadline(running, scheduler);

		expect(result.status).toBe("timeout");
		expect(result.finalState).toBe("TIMEOUT");
		expect(result.timeout.timedOut).toBe(true);
		expect(result.timeout.timeoutMs).toBe(TIMEOUT);
		expect(result.timeout.elapsedMs).toBeGreaterThanOrEqual(TIMEOUT);
		expect(result.timeout.deadlineAt).toBe(result.timeout.startedAt + TIMEOUT);
		expect(result.timeout.detectedAt).toBeGreaterThan(0);
	});

	test("continuous LLM activity does not extend the deadline", async () => {
		const gate = deferred();
		const scheduler = new VirtualWatchdogScheduler();
		const parks = [deferred(), deferred(), deferred(), deferred()];
		const fake = new FakeWorkerSession({
			gateAfterLlmActivity: gate.promise,
			parkGates: parks.map((p) => p.promise),
		});
		const running = makeHarness(fake, scheduler).run(spec());
		await tick();

		// Keep the Worker busy with fresh assistant activity, but never settle.
		for (const park of parks) {
			scheduler.advance(TIMEOUT / 4);
			gate.resolve();
			park.resolve();
			await tick();
		}
		expect(scheduler.now() - TIMEOUT).toBeGreaterThanOrEqual(0);

		scheduler.advance(GRACE + 100);
		const result = await running;
		expect(result.status).toBe("timeout");
		expect(result.finalState).toBe("TIMEOUT");
	});

	test("timeout while parked in LLM_GENERATING", async () => {
		const gate = deferred();
		const scheduler = new VirtualWatchdogScheduler();
		const states: string[] = [];
		const fake = new FakeWorkerSession({ gateAfterLlmActivity: gate.promise });
		const harness = new WorkerHarness({
			cwd: process.cwd(),
			timerScheduler: scheduler,
			watchdogIntervalMs: WATCHDOG_INTERVAL,
			workerTimeoutMs: TIMEOUT,
			drainGraceMs: GRACE,
			onStateChange: (s) => states.push(s.state),
			createSession: async () => ({ session: fake as never }),
		});

		const running = harness.run(spec());
		await tick();
		const result = await settleAfterDeadline(running, scheduler);

		expect(states).toContain("LLM_GENERATING");
		expect(result.finalState).toBe("TIMEOUT");
	});
});

// ---------------------------------------------------------------------------
// D: timeout during tool execution.
// ---------------------------------------------------------------------------

describe("Step 6 — D: timeout during tool execution", () => {
	test("a long-running tool does not hold the run open", async () => {
		const gate = deferred();
		const scheduler = new VirtualWatchdogScheduler();
		const fake = new FakeWorkerSession({
			tools: [{ toolName: "bash", toolCallId: "t1", holdOpen: gate.promise }],
		});
		const running = makeHarness(fake, scheduler).run(spec());
		await tick();

		const result = await settleAfterDeadline(running, scheduler);

		expect(result.status).toBe("timeout");
		expect(result.finalState).toBe("TIMEOUT");
	});
});

// ---------------------------------------------------------------------------
// F: steering does not reset the timeout.
// ---------------------------------------------------------------------------

describe("Step 6 — F: steering does not reset the deadline", () => {
	test("a steering action leaves the deadline unchanged", async () => {
		const gate = deferred();
		const scheduler = new VirtualWatchdogScheduler();
		const parks = [deferred(), deferred()];
		const fake = new FakeWorkerSession({
			gateAfterLlmActivity: gate.promise,
			parkGates: parks.map((p) => p.promise),
		});
		const harness = makeHarness(fake, scheduler, {
			watchdogIntervalMs: 500,
			llmIdleThresholdMs: 500,
			steeringCooldownMs: 1,
			maxSteeringCount: 5,
		});

		const running = harness.run(spec());
		await tick();
		scheduler.advance(1_500);
		await tick();
		expect(fake.steerCalls).toBeGreaterThan(0);

		// Deadline is still the original one; steering bought no extra time.
		scheduler.advance(TIMEOUT);
		await tick();
		scheduler.advance(GRACE + 100);
		const result = await running;

		expect(result.status).toBe("timeout");
		expect(result.timeout.timeoutMs).toBe(TIMEOUT);
		expect(result.steering.attempts).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// G / C-case: abort before timeout.
// ---------------------------------------------------------------------------

describe("Step 6 — G: abort before timeout", () => {
	test("an external abort yields ABORTED and the timeout never overwrites it", async () => {
		const gate = deferred();
		const scheduler = new VirtualWatchdogScheduler();
		const fake = new FakeWorkerSession({ gateAfterLlmActivity: gate.promise });
		const controller = new AbortController();
		const running = makeHarness(fake, scheduler).run(spec(), controller.signal);
		await tick();

		controller.abort();
		await tick();
		gate.resolve();
		scheduler.advance(TIMEOUT * 3);
		const result = await running;

		expect(result.status).toBe("aborted");
		expect(result.finalState).toBe("ABORTED");
		expect(result.timeout.timedOut).toBe(false);
		expect(fake.abortCount).toBe(1);
	});

	test("an abort before the run starts is reported without a session", async () => {
		const scheduler = new VirtualWatchdogScheduler();
		const controller = new AbortController();
		controller.abort();
		const result = await makeHarness(new FakeWorkerSession(), scheduler).run(
			spec(),
			controller.signal,
		);

		expect(result.status).toBe("aborted");
		expect(result.timeout.timedOut).toBe(false);
		expect(scheduler.liveTimerCount).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// H: abort that does not settle.
// ---------------------------------------------------------------------------

describe("Step 6 — H: non-cooperative abort", () => {
	test("worker_run still returns ABORTED when the session ignores abort()", async () => {
		const gate = deferred();
		const scheduler = new VirtualWatchdogScheduler();
		const fake = new FakeWorkerSession({
			gateAfterLlmActivity: gate.promise,
			nonCooperativeAbort: true,
		});
		const controller = new AbortController();
		const running = makeHarness(fake, scheduler).run(spec(), controller.signal);
		await tick();

		controller.abort();
		// The session never settles; the harness must not wait for it.
		const result = await driveUntilDone(running, scheduler);

		expect(result.status).toBe("aborted");
		expect(result.finalState).toBe("ABORTED");
		expect(fake.abortCount).toBe(1);
		expect(result.timeout.sessionDrained).toBe(false);
		expect(scheduler.liveTimerCount).toBe(0);

		gate.resolve();
	});
});

// ---------------------------------------------------------------------------
// I / L: timeout wins, later events cannot overwrite.
// ---------------------------------------------------------------------------

describe("Step 6 — I/L: TIMEOUT is final", () => {
	test("timeout before a later abort keeps TIMEOUT", async () => {
		const gate = deferred();
		const scheduler = new VirtualWatchdogScheduler();
		const fake = new FakeWorkerSession({ gateAfterLlmActivity: gate.promise });
		const controller = new AbortController();
		const running = makeHarness(fake, scheduler).run(spec(), controller.signal);
		await tick();

		scheduler.advance(TIMEOUT + 100);
		await tick();
		controller.abort();
		scheduler.advance(GRACE + 100);
		const result = await running;

		expect(result.status).toBe("timeout");
		expect(result.finalState).toBe("TIMEOUT");
		expect(result.timeout.timedOut).toBe(true);

		gate.resolve();
	});

	test("a late agent_settled cannot overwrite TIMEOUT", async () => {
		const gate = deferred();
		const scheduler = new VirtualWatchdogScheduler();
		const fake = new FakeWorkerSession({ gateAfterLlmActivity: gate.promise });
		const running = makeHarness(fake, scheduler).run(spec());
		await tick();

		scheduler.advance(TIMEOUT + 100);
		await tick();
		// Only now does the Worker actually finish.
		gate.resolve();
		await tick();
		scheduler.advance(GRACE + 100);
		const result = await running;

		expect(result.status).toBe("timeout");
		expect(result.finalState).toBe("TIMEOUT");
		// The late settle is recorded as a lost arbitration attempt, not the result.
		expect(fake.emittedEvents).toContain("agent_settled");
	});
});

// ---------------------------------------------------------------------------
// K: error before timeout.
// ---------------------------------------------------------------------------

describe("Step 6 — K: error before timeout", () => {
	test("a prompt failure wins over the deadline", async () => {
		const scheduler = new VirtualWatchdogScheduler();
		const fake = new FakeWorkerSession({ promptError: new Error("provider exploded") });
		const running = makeHarness(fake, scheduler).run(spec());
		await tick();
		scheduler.advance(TIMEOUT * 3);
		const result = await running;

		expect(result.status).toBe("error");
		expect(result.error).toContain("provider exploded");
		expect(result.timeout.timedOut).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// M: cleanup on every terminal path.
// ---------------------------------------------------------------------------

describe("Step 6 — M: cleanup", () => {
	const paths: Array<[string, () => { fake: FakeWorkerSession; signal?: AbortSignal }]> = [
		["finished", () => ({ fake: new FakeWorkerSession() })],
		["error", () => ({ fake: new FakeWorkerSession({ promptError: new Error("boom") }) })],
		[
			"aborted-before-start",
			() => {
				const c = new AbortController();
				c.abort();
				return { fake: new FakeWorkerSession(), signal: c.signal };
			},
		],
	];

	test.each(paths)("no timer remains after %s", async (_name, build) => {
		const scheduler = new VirtualWatchdogScheduler();
		const { fake, signal } = build();
		await makeHarness(fake, scheduler).run(spec(), signal);
		expect(scheduler.liveTimerCount).toBe(0);
	});

	test("no timer remains after a timeout", async () => {
		const gate = deferred();
		const scheduler = new VirtualWatchdogScheduler();
		const fake = new FakeWorkerSession({ gateAfterLlmActivity: gate.promise });
		const running = makeHarness(fake, scheduler).run(spec());
		await tick();
		await settleAfterDeadline(running, scheduler);
		expect(scheduler.liveTimerCount).toBe(0);
	});

	test("no timer remains after a session-creation failure", async () => {
		const scheduler = new VirtualWatchdogScheduler();
		const harness = new WorkerHarness({
			cwd: process.cwd(),
			timerScheduler: scheduler,
			workerTimeoutMs: TIMEOUT,
			drainGraceMs: GRACE,
			createSession: async () => {
				throw new Error("cannot create session");
			},
		});
		const result = await harness.run(spec());

		expect(result.status).toBe("error");
		expect(result.error).toContain("session creation failed");
		// SPEC §24: setup failure is never a timeout.
		expect(result.timeout.timedOut).toBe(false);
		expect(scheduler.liveTimerCount).toBe(0);
		expect(scheduler.scheduleCount).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// N / O: steering suppressed after timeout, diagnostics preserved.
// ---------------------------------------------------------------------------

describe("Step 6 — N/O: post-timeout steering and diagnostics", () => {
	test("no steering occurs after TIMEOUT", async () => {
		const gate = deferred();
		const scheduler = new VirtualWatchdogScheduler();
		const parks = [deferred(), deferred(), deferred()];
		const fake = new FakeWorkerSession({
			gateAfterLlmActivity: gate.promise,
			parkGates: parks.map((p) => p.promise),
		});
		const harness = makeHarness(fake, scheduler, {
			watchdogIntervalMs: 500,
			llmIdleThresholdMs: 500,
			steeringCooldownMs: 1,
			maxSteeringCount: 50,
		});

		const running = harness.run(spec());
		await tick();
		scheduler.advance(TIMEOUT + 100);
		await tick();

		const steersAtTimeout = fake.steerCalls;
		// Keep the Worker alive and stalling after the deadline won.
		for (const park of parks) {
			park.resolve();
			scheduler.advance(1_000);
			await tick();
		}
		scheduler.advance(GRACE + 100);
		const result = await running;

		expect(result.status).toBe("timeout");
		expect(fake.steerCalls).toBe(steersAtTimeout);
		gate.resolve();
	});

	test("watchdog, steering and boundary diagnostics survive a timeout", async () => {
		const gate = deferred();
		const scheduler = new VirtualWatchdogScheduler();
		const fake = new FakeWorkerSession({ gateAfterLlmActivity: gate.promise });
		const harness = makeHarness(fake, scheduler, {
			watchdogIntervalMs: 500,
			llmIdleThresholdMs: 500,
		});

		const running = harness.run(spec({ workType: "investigate" }));
		await tick();
		scheduler.advance(TIMEOUT + 100);
		await tick();
		scheduler.advance(GRACE + 100);
		const result = await running;

		expect(result.status).toBe("timeout");
		expect(result.watchdog.stallDetected).toBe(true);
		expect(result.watchdog.events.length).toBeGreaterThan(0);
		expect(result.boundary.readOnly).toBe(true);
		expect(result.timeout.timedOut).toBe(true);
		gate.resolve();
	});
});

// ---------------------------------------------------------------------------
// P: single-slot invariant.
// ---------------------------------------------------------------------------

describe("Step 6 — P: single-slot invariant", () => {
	test("a second run is refused while the first is live", async () => {
		const gate = deferred();
		const scheduler = new VirtualWatchdogScheduler();
		const fake = new FakeWorkerSession({ gateAfterLlmActivity: gate.promise });
		const harness = makeHarness(fake, scheduler);

		const running = harness.run(spec({ taskId: "first" }));
		await tick();
		expect(harness.isBusy).toBe(true);

		const second = await harness.run(spec({ taskId: "second" }));
		expect(second.status).toBe("error");
		expect(second.error).toContain("busy");

		gate.resolve();
		await running;
	});

	test("the slot is released after a timeout disposes the session", async () => {
		const gate = deferred();
		const scheduler = new VirtualWatchdogScheduler();
		const fake = new FakeWorkerSession({ gateAfterLlmActivity: gate.promise });
		const harness = makeHarness(fake, scheduler);

		const running = harness.run(spec({ taskId: "first" }));
		await tick();
		await settleAfterDeadline(running, scheduler);
		expect(harness.isBusy).toBe(false);

		// A new Worker can start once the timed-out session has been disposed.
		const next = new FakeWorkerSession();
		const harness2 = makeHarness(next, scheduler);
		expect(harness2.isBusy).toBe(false);
	});
});
