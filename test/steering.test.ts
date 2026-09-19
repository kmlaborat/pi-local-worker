import { describe, expect, test } from "vitest";

import type { TaskSpec } from "../src/task-spec.ts";
import {
	STEERING_MESSAGE,
	SteeringController,
	steeringMethodForState,
	type SteeringActuator,
	type SteeringProbe,
	type WorkerSteeringEvent,
} from "../src/steering.ts";
import type { WorkerState } from "../src/worker-state.ts";
import type { WorkerStallEvent } from "../src/watchdog.ts";
import { WorkerHarness } from "../src/worker-harness.ts";
import { FakeWorkerSession } from "./helpers/fake-session.ts";
import { VirtualWatchdogScheduler } from "./helpers/virtual-clock.ts";

const INTERVAL = 1_000;
const THRESHOLD = 5_000;
const COOLDOWN = 20_000;

function spec(overrides: Partial<TaskSpec> = {}): TaskSpec {
	return {
		taskId: "s5-task",
		goal: "steering test",
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

function stallAt(idleMs: number, turnId = 1): WorkerStallEvent {
	return {
		taskId: "s5-task",
		turnId,
		state: "LLM_GENERATING",
		detectedAt: 1000 + idleMs,
		lastActivityAt: 1000,
		idleMs,
		pendingToolCalls: 0,
		reason: "test stall",
	};
}

// ---------------------------------------------------------------------------
// Unit tests for the policy controller: pure, virtual clock, no session.
// ---------------------------------------------------------------------------

interface Ctrl {
	controller: SteeringController;
	events: WorkerSteeringEvent[];
	actuatorCalls: string[];
	set: (patch: Partial<SteeringProbe>) => void;
	failNext: (error: Error | undefined) => void;
	/** Move the controller's virtual clock forward between requests. */
	advance: (ms: number) => void;
	now: () => number;
}

function controller(
	initial: Partial<SteeringProbe> = {},
	opts: { cooldownMs?: number; maxSteeringCount?: number } = {},
): Ctrl {
	const probe: SteeringProbe = {
		state: "LLM_GENERATING",
		turnId: 1,
		pendingToolCalls: 0,
		isStreaming: true,
		...initial,
	};
	let clock = 1_000;
	let nextError: Error | undefined;
	const actuatorCalls: string[] = [];
	const events: WorkerSteeringEvent[] = [];

	const actuator: SteeringActuator = {
		steer: async (message) => {
			actuatorCalls.push(`steer:${message}`);
			if (nextError) throw nextError;
		},
		wakeIdle: async (message) => {
			actuatorCalls.push(`wakeIdle:${message}`);
			if (nextError) throw nextError;
		},
	};

	const c = new SteeringController({
		taskId: "s5-task",
		policy: {
			cooldownMs: opts.cooldownMs ?? COOLDOWN,
			maxSteeringCount: opts.maxSteeringCount ?? 5,
		},
		now: () => clock,
		probe: () => probe,
		actuator,
		onEvent: (e) => events.push(e),
	});

	return {
		controller: c,
		events,
		actuatorCalls,
		set: (patch) => Object.assign(probe, patch),
		failNext: (error) => {
			nextError = error;
		},
		advance: (ms) => {
			clock += ms;
		},
		now: () => clock,
	};
}

describe("Steering — A: generating stall steers", () => {
	test("LLM_GENERATING + no tools + idle over threshold => exactly one steer('.')", async () => {
		const c = controller({ state: "LLM_GENERATING", pendingToolCalls: 0, isStreaming: true });
		const event = await c.controller.request(stallAt(THRESHOLD + 1));

		expect(event.outcome).toBe("steered");
		expect(event.method).toBe("steer");
		expect(c.actuatorCalls).toEqual(["steer:."]);
		expect(c.controller.attemptsMade).toBe(1);
	});
});

describe("Steering — B: no steering during tool execution", () => {
	test("TOOL_EXECUTING with pending tools steers nothing, ever", async () => {
		const c = controller({ state: "TOOL_EXECUTING", pendingToolCalls: 1 });
		for (let i = 0; i < 5; i++) {
			const event = await c.controller.request(stallAt(THRESHOLD * 100));
			expect(event.outcome).toBe("skipped_tool_active");
		}
		expect(c.actuatorCalls).toEqual([]);
		expect(c.controller.attemptsMade).toBe(0);
	});

	test("parallel tools are also never steered", async () => {
		const c = controller({ state: "TOOL_EXECUTING", pendingToolCalls: 2 });
		const event = await c.controller.request(stallAt(THRESHOLD * 100));
		expect(event.outcome).toBe("skipped_tool_active");
		expect(event.pendingToolCalls).toBe(2);
		expect(c.actuatorCalls).toEqual([]);
	});
});

describe("Steering — C: idle wake-up", () => {
	test("WAITING_FOR_LLM uses sendUserMessage(deliverAs:'steer'), not steer()", async () => {
		const c = controller({ state: "WAITING_FOR_LLM", isStreaming: false });
		const event = await c.controller.request(stallAt(THRESHOLD + 1));

		expect(event.outcome).toBe("steered");
		expect(event.method).toBe("idle-wake");
		expect(c.actuatorCalls).toEqual(["wakeIdle:."]);
	});

	test("state -> method mapping is explicit and closed", () => {
		expect(steeringMethodForState("LLM_GENERATING")).toBe("steer");
		expect(steeringMethodForState("WAITING_FOR_LLM")).toBe("idle-wake");
		for (const state of [
			"INITIALIZING",
			"TOOL_EXECUTING",
			"TURN_COMPLETED",
			"FINISHED",
			"ERROR",
			"ABORTED",
			"TIMEOUT",
		] as WorkerState[]) {
			expect(steeringMethodForState(state)).toBeUndefined();
		}
	});

	test("LLM_GENERATING but not streaming refuses to dead-letter a queued steer", async () => {
		// pi's steer() only enqueues; with no active run it would never be
		// delivered, so the controller declines instead.
		const c = controller({ state: "LLM_GENERATING", isStreaming: false });
		const event = await c.controller.request(stallAt(THRESHOLD + 1));
		expect(event.outcome).toBe("skipped_race");
		expect(c.actuatorCalls).toEqual([]);
	});
});

describe("Steering — D: minimal message", () => {
	test("the message is exactly '.' on every dispatch path", async () => {
		const gen = controller({ state: "LLM_GENERATING" });
		await gen.controller.request(stallAt(THRESHOLD + 1));
		expect(gen.actuatorCalls).toEqual(["steer:."]);
		expect(gen.events[0]!.message).toBe(".");

		const idle = controller({ state: "WAITING_FOR_LLM", isStreaming: false });
		await idle.controller.request(stallAt(THRESHOLD + 1));
		expect(idle.actuatorCalls).toEqual(["wakeIdle:."]);
		expect(idle.events[0]!.message).toBe(".");

		expect(STEERING_MESSAGE).toBe(".");
	});

	test("no suppressed path carries a message", async () => {
		const c = controller({ state: "FINISHED" });
		const event = await c.controller.request(stallAt(THRESHOLD + 1));
		expect(event.message).toBeNull();
		expect(event.method).toBeNull();
	});
});

describe("Steering — E: cooldown", () => {
	test("a second request inside the cooldown is suppressed", async () => {
		const c = controller({}, { cooldownMs: COOLDOWN, maxSteeringCount: 5 });
		const first = await c.controller.request(stallAt(THRESHOLD + 1));
		expect(first.outcome).toBe("steered");

		// Same virtual instant: well inside cooldown.
		const second = await c.controller.request(stallAt(THRESHOLD + 2));
		expect(second.outcome).toBe("suppressed_cooldown");
		expect(c.actuatorCalls).toHaveLength(1);
	});

	test("cooldown is independent of stall-episode dedup", async () => {
		// Step 4 deliberately allows a fresh stall episode once activity resumes.
		// The cooldown must still hold the second one back.
		const c = controller({}, { cooldownMs: COOLDOWN, maxSteeringCount: 5 });
		await c.controller.request(stallAt(THRESHOLD + 1));
		// Fresh episode, different turn, still inside cooldown.
		const second = await c.controller.request(stallAt(THRESHOLD + 1, 2));
		expect(second.outcome).toBe("suppressed_cooldown");
		expect(c.actuatorCalls).toHaveLength(1);
	});
});

describe("Steering — F: cooldown expiry", () => {
	test("after the cooldown elapses another steering is allowed", async () => {
		let clock = 1_000;
		const calls: string[] = [];
		const c = new SteeringController({
			taskId: "s5-task",
			policy: { cooldownMs: COOLDOWN, maxSteeringCount: 5 },
			now: () => clock,
			probe: () => ({
				state: "LLM_GENERATING",
				turnId: 1,
				pendingToolCalls: 0,
				isStreaming: true,
			}),
			actuator: {
				steer: async (m) => void calls.push(m),
				wakeIdle: async (m) => void calls.push(m),
			},
		});

		await c.request(stallAt(THRESHOLD + 1));
		expect(calls).toHaveLength(1);

		// Exactly at the cooldown boundary is still suppressed (strictly less than).
		clock = 1_000 + COOLDOWN - 1;
		expect((await c.request(stallAt(THRESHOLD + 1))).outcome).toBe("suppressed_cooldown");

		clock = 1_000 + COOLDOWN;
		expect((await c.request(stallAt(THRESHOLD + 1))).outcome).toBe("steered");
		expect(calls).toEqual([".", "."]);
	});
});

describe("Steering — G: steering budget", () => {
	test("maxSteeringCount = 1 allows exactly one steer across many episodes", async () => {
		let clock = 1_000;
		const calls: string[] = [];
		const c = new SteeringController({
			taskId: "s5-task",
			policy: { cooldownMs: 1, maxSteeringCount: 1 },
			now: () => clock,
			probe: () => ({
				state: "LLM_GENERATING",
				turnId: 1,
				pendingToolCalls: 0,
				isStreaming: true,
			}),
			actuator: {
				steer: async (m) => void calls.push(m),
				wakeIdle: async (m) => void calls.push(m),
			},
		});

		for (let i = 0; i < 6; i++) {
			clock += 1_000;
			const event = await c.request(stallAt(THRESHOLD + 1, i + 1));
			if (i === 0) expect(event.outcome).toBe("steered");
			else expect(event.outcome).toBe("suppressed_budget");
		}

		expect(calls).toEqual(["."]);
		expect(c.attemptsMade).toBe(1);
	});
});

describe("Steering — H: budget suppression is structured data", () => {
	test("suppression carries outcome, attempts, max and reason", async () => {
		const c = controller({}, { cooldownMs: 1, maxSteeringCount: 1 });
		await c.controller.request(stallAt(THRESHOLD + 1));
		// Past the cooldown, and a distinct episode (different turn and
		// last-activity timestamp), so only the budget can stop this one.
		c.advance(10);
		const suppressed = await c.controller.request({
			...stallAt(THRESHOLD + 1, 2),
			lastActivityAt: 5_000,
		});

		expect(suppressed.outcome).toBe("suppressed_budget");
		expect(suppressed.attempts).toBe(1);
		expect(suppressed.maxSteeringCount).toBe(1);
		expect(suppressed.method).toBeNull();
		expect(suppressed.message).toBeNull();
		expect(suppressed.reason).toContain("budget exhausted");
		expect(suppressed.reason).toContain("1/1");
		expect(suppressed.taskId).toBe("s5-task");
		// turnId reflects the Worker's live turn from the probe, not the stall
		// event's, so a stale stall cannot mislabel the decision.
		expect(suppressed.turnId).toBe(1);
	});
});

describe("Steering — I: terminal race", () => {
	test("Worker finishing between detection and dispatch prevents steering", async () => {
		const c = controller({ state: "LLM_GENERATING" });
		// Terminal marker set before the request is even evaluated.
		c.controller.markTerminal();
		const event = await c.controller.request(stallAt(THRESHOLD + 1));

		expect(event.outcome).toBe("skipped_terminal");
		expect(c.actuatorCalls).toEqual([]);
	});

	test.each(["FINISHED", "ERROR", "ABORTED", "TIMEOUT"] as WorkerState[])(
		"%s state is never steered",
		async (state) => {
			const c = controller({ state });
			const event = await c.controller.request(stallAt(THRESHOLD + 1));
			expect(event.outcome).toBe("skipped_terminal");
			expect(c.actuatorCalls).toEqual([]);
		},
	);

	test("markTerminal after a successful steer blocks further steering", async () => {
		const c = controller({}, { cooldownMs: 1, maxSteeringCount: 5 });
		expect((await c.controller.request(stallAt(THRESHOLD + 1))).outcome).toBe("steered");
		c.controller.markTerminal();
		expect((await c.controller.request(stallAt(THRESHOLD + 1, 2))).outcome).toBe("skipped_terminal");
		expect(c.actuatorCalls).toHaveLength(1);
	});
});

describe("Steering — J: tool race", () => {
	test("a tool starting between detection and dispatch prevents steering", async () => {
		// The probe reports a clean state on the eligibility read, then a tool
		// appears on the pre-dispatch re-read.
		let reads = 0;
		const calls: string[] = [];
		const c = new SteeringController({
			taskId: "s5-task",
			policy: { cooldownMs: 1, maxSteeringCount: 5 },
			now: () => 1_000,
			probe: () => {
				reads += 1;
				return {
					state: "LLM_GENERATING",
					turnId: 1,
					// First read: idle. Second read (pre-dispatch): tool appeared.
					pendingToolCalls: reads >= 2 ? 1 : 0,
					isStreaming: true,
				};
			},
			actuator: {
				steer: async (m) => void calls.push(m),
				wakeIdle: async (m) => void calls.push(m),
			},
		});

		const event = await c.request(stallAt(THRESHOLD + 1));
		expect(event.outcome).toBe("skipped_tool_active");
		expect(event.pendingToolCalls).toBe(1);
		expect(calls).toEqual([]);
		expect(c.attemptsMade).toBe(0);
	});
});

describe("Steering — K: steering failure", () => {
	test("a throwing steer() is recorded and consumes budget, Worker untouched", async () => {
		const c = controller({}, { cooldownMs: 1, maxSteeringCount: 5 });
		c.failNext(new Error("native steer exploded"));
		const event = await c.controller.request(stallAt(THRESHOLD + 1));

		expect(event.outcome).toBe("failed");
		expect(event.method).toBe("steer");
		expect(event.error).toBe("native steer exploded");
		// Attempt counted: a throwing API must not be retried every tick.
		expect(c.controller.attemptsMade).toBe(1);
	});

	test("a throwing idle-wake is recorded the same way", async () => {
		const c = controller({ state: "WAITING_FOR_LLM", isStreaming: false });
		c.failNext(new Error("wake rejected"));
		const event = await c.controller.request(stallAt(THRESHOLD + 1));
		expect(event.outcome).toBe("failed");
		expect(event.method).toBe("idle-wake");
		expect(event.error).toBe("wake rejected");
	});

	test("request() never rejects even when the actuator throws", async () => {
		const c = controller();
		c.failNext(new Error("boom"));
		await expect(c.controller.request(stallAt(THRESHOLD + 1))).resolves.toMatchObject({
			outcome: "failed",
		});
	});
});

// ---------------------------------------------------------------------------
// Harness integration.
// ---------------------------------------------------------------------------

function harnessWithFake(
	fake: FakeWorkerSession,
	scheduler: VirtualWatchdogScheduler,
	extra: Record<string, unknown> = {},
): WorkerHarness {
	return new WorkerHarness({
		cwd: process.cwd(),
		timerScheduler: scheduler,
		watchdogIntervalMs: INTERVAL,
		llmIdleThresholdMs: THRESHOLD,
		steeringCooldownMs: COOLDOWN,
		maxSteeringCount: 3,
		createSession: async () => ({ session: fake as never }),
		...extra,
	});
}

describe("Steering — harness integration", () => {
	test("a real stall during generation produces exactly one native steer('.')", async () => {
		const gate = deferred();
		const scheduler = new VirtualWatchdogScheduler();
		const fake = new FakeWorkerSession({ gateAfterLlmActivity: gate.promise });
		const harness = harnessWithFake(fake, scheduler);

		const running = harness.run(spec());
		await tick();
		scheduler.advance(THRESHOLD + INTERVAL);
		await tick();

		expect(fake.steerCalls).toBe(1);
		expect(fake.steerArgs).toEqual([["."]]);
		expect(fake.sendUserMessageCalls).toBe(0);

		gate.resolve();
		const result = await running;

		expect(result.status).toBe("completed");
		expect(result.finalState).toBe("FINISHED");
		expect(result.watchdog.stallDetected).toBe(true);
		expect(result.steering.steeringPerformed).toBe(true);
		expect(result.steering.attempts).toBe(1);
		expect(result.steering.events[0]!.method).toBe("steer");
		expect(result.steering.events[0]!.message).toBe(".");
	});

	test("cooldown prevents a second steer inside the window", async () => {
		const park1 = deferred();
		const park2 = deferred();
		const scheduler = new VirtualWatchdogScheduler();
		const fake = new FakeWorkerSession({
			gateAfterLlmActivity: park1.promise,
			parkGates: [park2.promise],
		});
		const harness = harnessWithFake(fake, scheduler, {
			steeringCooldownMs: COOLDOWN,
			maxSteeringCount: 5,
		});

		const running = harness.run(spec());
		await tick();

		// Episode #1: stall, steer.
		scheduler.advance(THRESHOLD + INTERVAL);
		await tick();
		expect(fake.steerCalls).toBe(1);
		const steeredAt = scheduler.now();

		// Activity resumes: the Step 4 episode is cleared.
		park1.resolve();
		await tick();

		// Episode #2: stall again, but still inside the cooldown.
		scheduler.advance(COOLDOWN - INTERVAL - 1);
		await tick();
		expect(scheduler.now() - steeredAt).toBeLessThan(COOLDOWN);
		expect(fake.steerCalls).toBe(1);

		park2.resolve();
		const result = await running;
		expect(result.watchdog.events.length).toBeGreaterThanOrEqual(2);
		expect(result.steering.events.filter((e) => e.outcome === "steered")).toHaveLength(1);
		expect(result.steering.events.some((e) => e.outcome === "suppressed_cooldown")).toBe(true);
	});

	test("budget exhaustion is reported and never escalates", async () => {
		const park1 = deferred();
		const park2 = deferred();
		const scheduler = new VirtualWatchdogScheduler();
		const fake = new FakeWorkerSession({
			gateAfterLlmActivity: park1.promise,
			parkGates: [park2.promise],
		});
		const harness = harnessWithFake(fake, scheduler, {
			steeringCooldownMs: INTERVAL,
			maxSteeringCount: 1,
		});

		const running = harness.run(spec());
		await tick();

		// Episode #1 consumes the whole budget.
		scheduler.advance(THRESHOLD + INTERVAL);
		await tick();
		expect(fake.steerCalls).toBe(1);

		// Resume, then stall again past both cooldown and threshold.
		park1.resolve();
		await tick();
		scheduler.advance(THRESHOLD + INTERVAL * 2);
		await tick();

		// Budget is gone: no second steer, and no escalation either.
		expect(fake.steerCalls).toBe(1);
		expect(fake.abortCount).toBe(0);

		park2.resolve();
		const result = await running;
		expect(result.steering.attempts).toBe(1);
		expect(result.steering.budgetExhausted).toBe(true);
		expect(result.steering.events.some((e) => e.outcome === "suppressed_budget")).toBe(true);
		expect(result.status).toBe("completed");
	});

	test("steering failure does not change the Worker result", async () => {
		const gate = deferred();
		const scheduler = new VirtualWatchdogScheduler();
		const fake = new FakeWorkerSession({
			gateAfterLlmActivity: gate.promise,
			steerError: new Error("session refuses to steer"),
		});
		const harness = harnessWithFake(fake, scheduler);

		const running = harness.run(spec());
		await tick();
		scheduler.advance(THRESHOLD + INTERVAL);
		await tick();

		gate.resolve();
		const result = await running;

		expect(result.steering.steeringPerformed).toBe(false);
		expect(result.steering.events[0]!.outcome).toBe("failed");
		expect(result.steering.events[0]!.error).toBe("session refuses to steer");
		// The Worker itself is untouched by the failed intervention.
		expect(result.status).toBe("completed");
		expect(result.error).toBeNull();
		expect(result.finalState).toBe("FINISHED");
	});

	test("terminal state wins: no steering after settle", async () => {
		const scheduler = new VirtualWatchdogScheduler();
		const fake = new FakeWorkerSession();
		const harness = harnessWithFake(fake, scheduler);

		const result = await harness.run(spec());
		// Nothing stalled, so nothing steered, and the controller is terminal.
		expect(fake.steerCalls).toBe(0);
		expect(fake.sendUserMessageCalls).toBe(0);
		expect(result.steering.events).toEqual([]);
	});

	test("steering is disabled => pure Step 4 observation", async () => {
		const gate = deferred();
		const scheduler = new VirtualWatchdogScheduler();
		const fake = new FakeWorkerSession({ gateAfterLlmActivity: gate.promise });
		const harness = harnessWithFake(fake, scheduler, { steeringEnabled: false });

		const running = harness.run(spec());
		await tick();
		scheduler.advance(THRESHOLD * 3);
		await tick();

		expect(fake.steerCalls).toBe(0);
		expect(fake.sendUserMessageCalls).toBe(0);

		gate.resolve();
		const result = await running;
		expect(result.watchdog.stallDetected).toBe(true);
		expect(result.steering.steeringPerformed).toBe(false);
		expect(result.status).toBe("completed");
	});
});

describe("Steering — L: no abort anywhere", () => {
	test("abort count stays 0 across every stall/steering scenario", async () => {
		const scenarios: Array<[string, Record<string, unknown>]> = [
			["default", {}],
			["no cooldown, big budget", { steeringCooldownMs: 1, maxSteeringCount: 50 }],
			["budget 1", { maxSteeringCount: 1 }],
			["steering off", { steeringEnabled: false }],
		];

		for (const [name, extra] of scenarios) {
			const gate = deferred();
			const scheduler = new VirtualWatchdogScheduler();
			const fake = new FakeWorkerSession({ gateAfterLlmActivity: gate.promise });
			const harness = harnessWithFake(fake, scheduler, extra);

			const running = harness.run(spec());
			await tick();
			scheduler.advance(THRESHOLD * 10);
			await tick();
			gate.resolve();
			await running;

			expect(fake.abortCount, name).toBe(0);
		}
	});

	test("external AbortSignal still aborts exactly as before", async () => {
		const scheduler = new VirtualWatchdogScheduler();
		const controller = new AbortController();
		controller.abort();
		const result = await harnessWithFake(new FakeWorkerSession(), scheduler).run(
			spec(),
			controller.signal,
		);
		expect(result.status).toBe("aborted");
	});
});

describe("Steering — M: Step 4 behavior preserved", () => {
	test("stall detection is unchanged when steering is enabled", async () => {
		const gate = deferred();
		const scheduler = new VirtualWatchdogScheduler();
		const fake = new FakeWorkerSession({ gateAfterLlmActivity: gate.promise });
		const harness = harnessWithFake(fake, scheduler);

		const running = harness.run(spec());
		await tick();
		scheduler.advance(THRESHOLD + INTERVAL);
		// Step 4 dedup: one episode, one stall event, however many ticks.
		scheduler.advance(THRESHOLD * 4);
		await tick();

		gate.resolve();
		const result = await running;
		expect(result.watchdog.events).toHaveLength(1);
		expect(result.watchdog.stallDetected).toBe(true);
	});

	test("tool execution still never stalls and never steers", async () => {
		const scheduler = new VirtualWatchdogScheduler();
		const fake = new FakeWorkerSession({
			tools: [{ toolName: "read", toolCallId: "t1" }],
		});
		const harness = harnessWithFake(fake, scheduler);
		const result = await harness.run(spec());

		expect(result.watchdog.stallDetected).toBe(false);
		expect(result.steering.steeringPerformed).toBe(false);
		expect(fake.steerCalls).toBe(0);
	});
});
