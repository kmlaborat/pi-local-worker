import { describe, expect, test } from "vitest";

import { WorkerHarness, type WorkerHarnessConfig } from "../src/worker-harness.ts";
import type { TaskSpec } from "../src/task-spec.ts";
import type { WorkerState } from "../src/worker-state.ts";
import { WorkerStateTracker } from "../src/worker-state.ts";
import { WorkerWatchdog, type WorkerStallEvent } from "../src/watchdog.ts";
import { FakeWorkerSession } from "./helpers/fake-session.ts";
import { VirtualWatchdogScheduler } from "./helpers/virtual-clock.ts";

const INTERVAL = 1_000;
const THRESHOLD = 5_000;

function spec(overrides: Partial<TaskSpec> = {}): TaskSpec {
	return {
		taskId: "wd-task",
		goal: "watchdog test",
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

async function tick(times = 3) {
	for (let i = 0; i < times; i++) {
		await new Promise((r) => setTimeout(r, 0));
	}
}

interface Fixture {
	scheduler: VirtualWatchdogScheduler;
	events: WorkerStallEvent[];
	watchdog: WorkerWatchdog;
	set: (patch: Partial<{ state: WorkerState; turnId: number; lastActivity: number; pending: number }>) => void;
}

function fixture(initial?: Partial<{ state: WorkerState; turnId: number; pending: number }>): Fixture {
	const scheduler = new VirtualWatchdogScheduler();
	const events: WorkerStallEvent[] = [];
	const probe = {
		state: (initial?.state ?? "LLM_GENERATING") as WorkerState,
		turnId: initial?.turnId ?? 1,
		lastActivity: scheduler.now(),
		pending: initial?.pending ?? 0,
	};
	const watchdog = new WorkerWatchdog({
		taskId: "wd-task",
		scheduler,
		intervalMs: INTERVAL,
		llmIdleThresholdMs: THRESHOLD,
		probe: () => ({
			state: probe.state,
			turnId: probe.turnId,
			lastLlmActivityAt: probe.lastActivity,
			pendingToolCalls: probe.pending,
		}),
		onStall: (event) => events.push(event),
	});
	return {
		scheduler,
		events,
		watchdog,
		set: (patch) => {
			if (patch.state !== undefined) probe.state = patch.state;
			if (patch.turnId !== undefined) probe.turnId = patch.turnId;
			if (patch.lastActivity !== undefined) probe.lastActivity = patch.lastActivity;
			if (patch.pending !== undefined) probe.pending = patch.pending;
		},
	};
}

describe("Watchdog — A: healthy LLM generation", () => {
	test("activity on every tick produces no stall event", () => {
		const f = fixture();
		f.watchdog.start();
		for (let i = 0; i < 10; i++) {
			f.scheduler.advance(INTERVAL);
			// Generation keeps making progress.
			f.set({ lastActivity: f.scheduler.now() });
		}
		expect(f.events).toHaveLength(0);
	});
});

describe("Watchdog — B: LLM stall", () => {
	test("exactly one stall event once the idle threshold is exceeded", () => {
		const f = fixture();
		f.watchdog.start();
		f.scheduler.advance(THRESHOLD);
		// Exactly at the threshold is not over it.
		expect(f.events).toHaveLength(0);

		// The next tick lands past the threshold.
		f.scheduler.advance(INTERVAL);
		expect(f.events).toHaveLength(1);

		const event = f.events[0]!;
		expect(event.taskId).toBe("wd-task");
		expect(event.state).toBe("LLM_GENERATING");
		expect(event.turnId).toBe(1);
		expect(event.pendingToolCalls).toBe(0);
		expect(event.idleMs).toBe(THRESHOLD + INTERVAL);
		expect(event.lastActivityAt).toBeTypeOf("number");
		expect(event.reason).toContain("Probable stall");
	});

	test("check() before start() does nothing", () => {
		const f = fixture();
		expect(f.watchdog.check()).toBeUndefined();
		expect(f.watchdog.isRunning).toBe(false);
	});

	test("start() is idempotent", () => {
		const f = fixture();
		f.watchdog.start();
		f.watchdog.start();
		expect(f.scheduler.scheduleCount).toBe(1);
	});
});

describe("Watchdog — C: no duplicate stall events", () => {
	test("the same ongoing stall is reported once, however many ticks pass", () => {
		const f = fixture();
		f.watchdog.start();
		for (let i = 0; i < 20; i++) {
			f.scheduler.advance(INTERVAL);
		}
		expect(f.events).toHaveLength(1);
	});
});

describe("Watchdog — D: activity clears the stall episode", () => {
	test("resumed activity allows a later quiet period to be a new stall", () => {
		const f = fixture();
		f.watchdog.start();

		f.scheduler.advance(THRESHOLD + INTERVAL);
		expect(f.events).toHaveLength(1);

		// Generation resumes.
		f.set({ lastActivity: f.scheduler.now() });
		f.scheduler.advance(INTERVAL);
		expect(f.events).toHaveLength(1);

		// Goes quiet again -> a fresh episode.
		f.scheduler.advance(THRESHOLD + INTERVAL);
		expect(f.events).toHaveLength(2);
		expect(f.events[1]!.idleMs).toBeGreaterThan(THRESHOLD);
	});
});

describe("Watchdog — E/F: tool execution is never an LLM stall", () => {
	test("TOOL_EXECUTING with no LLM output never stalls, however long it runs", () => {
		const f = fixture({ state: "TOOL_EXECUTING", pending: 1 });
		f.watchdog.start();
		f.scheduler.advance(THRESHOLD * 100);
		expect(f.events).toHaveLength(0);
	});

	test("parallel tools (pendingToolCalls === 2) never stall", () => {
		const f = fixture({ state: "TOOL_EXECUTING", pending: 2 });
		f.watchdog.start();
		f.scheduler.advance(THRESHOLD * 100);
		expect(f.events).toHaveLength(0);
	});

	test("a tool starting mid-stall suppresses the LLM stall", () => {
		const f = fixture();
		f.watchdog.start();
		f.scheduler.advance(THRESHOLD + INTERVAL);
		expect(f.events).toHaveLength(1);

		// A tool begins: silence is now expected.
		f.set({ state: "TOOL_EXECUTING", pending: 1 });
		f.scheduler.advance(THRESHOLD * 10);
		expect(f.events).toHaveLength(1);
	});

	test("pendingToolCalls > 0 suppresses even if the state still reads LLM_GENERATING", () => {
		// Defensive layering: the tool-count guard is independent of the state value.
		const f = fixture({ pending: 0 });
		f.set({ pending: 3 });
		f.watchdog.start();
		f.scheduler.advance(THRESHOLD * 10);
		expect(f.events).toHaveLength(0);
	});
});

describe("Watchdog — G: turn boundaries reset activity tracking", () => {
	test("a new turn can produce a new stall episode", () => {
		const f = fixture({ turnId: 1 });
		f.watchdog.start();
		f.scheduler.advance(THRESHOLD + INTERVAL);
		expect(f.events).toHaveLength(1);

		// Same last-activity timestamp, but a different turn.
		f.set({ turnId: 2 });
		f.scheduler.advance(THRESHOLD + INTERVAL);
		expect(f.events).toHaveLength(2);
		expect(f.events[1]!.turnId).toBe(2);
	});

	test("the tracker refreshes lastLlmActivityAt on turn_start", () => {
		const scheduler = new VirtualWatchdogScheduler(500_000);
		const tracker = new WorkerStateTracker({
			getPendingToolCalls: () => 0,
			now: () => scheduler.now(),
		});

		tracker.handle({ type: "agent_start" } as never);
		tracker.handle({ type: "turn_start" } as never);
		const firstTurnActivity = tracker.lastLlmActivityAt!;
		expect(tracker.turnId).toBe(1);

		scheduler.advance(10_000);
		tracker.handle({
			type: "message_update",
			message: { role: "assistant", content: [] },
		} as never);
		expect(tracker.lastLlmActivityAt).toBe(510_000);

		// A new turn must not carry the previous turn's timestamp forward.
		scheduler.advance(7_000);
		tracker.handle({ type: "turn_end", message: { role: "assistant", stopReason: "stop" } } as never);
		tracker.handle({ type: "turn_start" } as never);
		expect(tracker.turnId).toBe(2);
		expect(tracker.lastLlmActivityAt).toBe(517_000);
		expect(tracker.lastLlmActivityAt).not.toBe(firstTurnActivity);
	});

	test("non-assistant messages never refresh LLM activity", () => {
		const scheduler = new VirtualWatchdogScheduler(100);
		const tracker = new WorkerStateTracker({
			getPendingToolCalls: () => 0,
			now: () => scheduler.now(),
		});
		tracker.handle({ type: "agent_start" } as never);
		tracker.handle({ type: "turn_start" } as never);
		const baseline = tracker.lastLlmActivityAt!;

		scheduler.advance(4_000);
		for (const message of [
			{ role: "user", content: [] },
			{ role: "toolResult", content: [] },
			{ role: "custom", customType: "x", content: [] },
		]) {
			tracker.handle({ type: "message_start", message } as never);
			tracker.handle({ type: "message_update", message } as never);
			tracker.handle({ type: "message_end", message } as never);
		}
		expect(tracker.lastLlmActivityAt).toBe(baseline);
	});
});

describe("Watchdog — H: WAITING_FOR_LLM is conservative", () => {
	test("a long WAITING_FOR_LLM period never produces a stall event", () => {
		const f = fixture({ state: "WAITING_FOR_LLM" });
		f.watchdog.start();
		f.scheduler.advance(THRESHOLD * 100);
		expect(f.events).toHaveLength(0);
	});

	test.each(["TURN_COMPLETED", "FINISHED", "ERROR", "ABORTED", "TIMEOUT", "INITIALIZING"] as WorkerState[])(
		"%s is never a stall candidate",
		(state) => {
			const f = fixture({ state });
			f.watchdog.start();
			f.scheduler.advance(THRESHOLD * 100);
			expect(f.events).toHaveLength(0);
		},
	);
});

// ---------------------------------------------------------------------------
// Harness integration: lifecycle, cleanup, and the no-intervention guarantee.
// ---------------------------------------------------------------------------

function harnessWithFake(
	fake: FakeWorkerSession,
	scheduler: VirtualWatchdogScheduler,
	extra: Partial<WorkerHarnessConfig> = {},
): WorkerHarness {
	return new WorkerHarness({
		cwd: process.cwd(),
		timerScheduler: scheduler,
		watchdogIntervalMs: INTERVAL,
		llmIdleThresholdMs: THRESHOLD,
		createSession: async () => ({ session: fake as never }),
		...extra,
	});
}

describe("Watchdog — I/J: lifecycle and cleanup", () => {
	test("the watchdog is running while the Worker is parked mid-generation", async () => {
		const gate = deferred();
		const scheduler = new VirtualWatchdogScheduler();
		const fake = new FakeWorkerSession({ gateAfterLlmActivity: gate.promise });
		const harness = harnessWithFake(fake, scheduler);

		const running = harness.run(spec());
		await tick();

		// Two live timers: the watchdog interval and the Worker timeout one-shot.
		expect(scheduler.liveTimerCount).toBe(2);
		expect(scheduler.scheduleCount).toBe(2);

		gate.resolve();
		await running;
	});

	test("no timer remains after a normal FINISHED run", async () => {
		const scheduler = new VirtualWatchdogScheduler();
		const result = await harnessWithFake(new FakeWorkerSession(), scheduler).run(spec());

		expect(result.finalState).toBe("FINISHED");
		// Watchdog interval and timeout one-shot both torn down.
		expect(scheduler.liveTimerCount).toBe(0);
		expect(scheduler.unscheduleCount).toBe(2);
	});

	test("no timer remains after an ERROR run", async () => {
		const scheduler = new VirtualWatchdogScheduler();
		const result = await harnessWithFake(new FakeWorkerSession({ stopReason: "error" }), scheduler).run(spec());

		expect(result.status).toBe("error");
		expect(scheduler.liveTimerCount).toBe(0);
	});

	test("no timer remains after an ABORTED run", async () => {
		const scheduler = new VirtualWatchdogScheduler();
		const controller = new AbortController();
		controller.abort();
		const result = await harnessWithFake(new FakeWorkerSession(), scheduler).run(spec(), controller.signal);

		expect(result.status).toBe("aborted");
		expect(scheduler.liveTimerCount).toBe(0);
	});

	test("no timer remains after a prompt failure", async () => {
		const scheduler = new VirtualWatchdogScheduler();
		const fake = new FakeWorkerSession({ promptError: new Error("boom") });
		const result = await harnessWithFake(fake, scheduler).run(spec());

		expect(result.status).toBe("error");
		expect(scheduler.liveTimerCount).toBe(0);
	});

	test("agent_settled while the interval is live shuts the watchdog down", async () => {
		const gate = deferred();
		const scheduler = new VirtualWatchdogScheduler();
		const fake = new FakeWorkerSession({ gateAfterLlmActivity: gate.promise });
		const harness = harnessWithFake(fake, scheduler);

		const running = harness.run(spec());
		await tick();
		expect(scheduler.liveTimerCount).toBe(2);

		// Stall fires while the Worker is parked.
		scheduler.advance(THRESHOLD + INTERVAL);
		expect(scheduler.liveTimerCount).toBe(2);

		gate.resolve();
		const result = await running;

		// The terminal event won: the interval is gone.
		expect(result.finalState).toBe("FINISHED");
		expect(scheduler.liveTimerCount).toBe(0);
	});
});

describe("Watchdog — K: detection never means intervention", () => {
	// Step 4's invariant, preserved verbatim with the Step 5 steering controller
	// switched off: the watchdog alone must never touch the Worker.
	test("a detected stall triggers no steer / sendUserMessage / abort", async () => {
		const gate = deferred();
		const scheduler = new VirtualWatchdogScheduler();
		const fake = new FakeWorkerSession({ gateAfterLlmActivity: gate.promise });
		const harness = harnessWithFake(fake, scheduler, { steeringEnabled: false });

		const running = harness.run(spec());
		await tick();

		scheduler.advance(THRESHOLD + INTERVAL);
		expect(fake.steerCalls).toBe(0);
		expect(fake.sendUserMessageCalls).toBe(0);
		expect(fake.abortCount).toBe(0);

		// Keep ticking: still nothing.
		scheduler.advance(THRESHOLD * 5);
		expect(fake.steerCalls).toBe(0);
		expect(fake.sendUserMessageCalls).toBe(0);
		expect(fake.abortCount).toBe(0);

		gate.resolve();
		const result = await running;

		expect(fake.steerCalls).toBe(0);
		expect(fake.sendUserMessageCalls).toBe(0);
		expect(fake.abortCount).toBe(0);
		// And the Worker still finished normally.
		expect(result.status).toBe("completed");
		expect(result.finalState).toBe("FINISHED");
	});

	test("the stall is reported in the result without changing the Worker status", async () => {
		const gate = deferred();
		const scheduler = new VirtualWatchdogScheduler();
		const fake = new FakeWorkerSession({ gateAfterLlmActivity: gate.promise });
		const harness = harnessWithFake(fake, scheduler);

		const running = harness.run(spec());
		await tick();
		scheduler.advance(THRESHOLD + INTERVAL);
		gate.resolve();
		const result = await running;

		expect(result.watchdog.stallDetected).toBe(true);
		expect(result.watchdog.events).toHaveLength(1);
		expect(result.watchdog.events[0]!.state).toBe("LLM_GENERATING");
		expect(result.watchdog.intervalMs).toBe(INTERVAL);
		expect(result.watchdog.llmIdleThresholdMs).toBe(THRESHOLD);
		// Observation, not a terminal status.
		expect(result.status).toBe("completed");
		expect(result.error).toBeNull();
	});

	test("a healthy run reports no stall", async () => {
		const scheduler = new VirtualWatchdogScheduler();
		const result = await harnessWithFake(new FakeWorkerSession(), scheduler).run(spec());
		expect(result.watchdog.stallDetected).toBe(false);
		expect(result.watchdog.events).toHaveLength(0);
	});
});
