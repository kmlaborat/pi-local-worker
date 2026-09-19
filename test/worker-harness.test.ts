import {
	ModelRuntime,
	SessionManager,
	type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";

import { WorkerHarness, type WorkerSession } from "../src/worker-harness.ts";
import type { TaskSpec } from "../src/task-spec.ts";
import {
	DEFAULT_LLM_IDLE_THRESHOLD_MS,
	DEFAULT_WATCHDOG_INTERVAL_MS,
} from "../src/watchdog.ts";
import {
	DEFAULT_MAX_STEERING_COUNT,
	DEFAULT_STEERING_COOLDOWN_MS,
} from "../src/steering.ts";
import {
	DEFAULT_DRAIN_GRACE_MS,
	DEFAULT_WORKER_TIMEOUT_MS,
} from "../src/timeout.ts";
import { FakeWorkerSession, type FakeSessionOptions } from "./helpers/fake-session.ts";
import { cleanWorkspace, unchangedEvidence } from "./helpers/fake-git.ts";

interface Captured {
	sessions: FakeWorkerSession[];
	options: CreateAgentSessionOptions[];
}

function makeHarness(
	fakeOptions: FakeSessionOptions = {},
	captured: Captured = { sessions: [], options: [] },
) {
	// A fake Git runner keeps the evidence deterministic: the real repository's
	// dirt must not leak into assertions about the Worker result shape.
	const git = cleanWorkspace();
	const harness = new WorkerHarness({
		cwd: git.dir,
		gitRunner: git.runner,
		createSession: async (options) => {
			const session = new FakeWorkerSession(fakeOptions);
			captured.sessions.push(session);
			captured.options.push(options);
			return { session: session as unknown as WorkerSession };
		},
	});
	return { harness, captured, git };
}

function spec(overrides: Partial<TaskSpec> = {}): TaskSpec {
	return {
		taskId: "task-1",
		goal: "Do the thing.",
		scope: ["src/thing.ts"],
		workType: "implement",
		completionCriteria: ["thing done"],
		...overrides,
	};
}

function deferred(): Promise<void> & { resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return Object.assign(promise, { resolve });
}

async function tick() {
	await new Promise((r) => setTimeout(r, 0));
}

describe("WorkerHarness — happy path", () => {
	test("creates a Worker session and runs the TaskSpec through it", async () => {
		const { harness, captured } = makeHarness({ text: "all green" });

		const result = await harness.run(spec());

		expect(captured.sessions).toHaveLength(1);
		expect(captured.sessions[0]!.promptedTexts).toHaveLength(1);
		expect(result).toEqual({
			taskId: "task-1",
			status: "completed",
			finalResponse: "all green",
			error: null,
			finalState: "FINISHED",
			boundary: { readOnly: false, violations: [] },
			watchdog: {
				stallDetected: false,
				events: [],
				intervalMs: DEFAULT_WATCHDOG_INTERVAL_MS,
				llmIdleThresholdMs: DEFAULT_LLM_IDLE_THRESHOLD_MS,
			},
			steering: {
				steeringPerformed: false,
				attempts: 0,
				maxSteeringCount: DEFAULT_MAX_STEERING_COUNT,
				cooldownMs: DEFAULT_STEERING_COOLDOWN_MS,
				budgetExhausted: false,
				events: [],
			},
			timeout: expect.objectContaining({
				timedOut: false,
				timeoutMs: DEFAULT_WORKER_TIMEOUT_MS,
				drainGraceMs: DEFAULT_DRAIN_GRACE_MS,
				sessionDrained: true,
				detectedAt: 0,
			}),
			workspaceEvidence: unchangedEvidence(),
			// workType "implement" gets no default invariant, and this spec has no
			// structured completionChecks, so nothing is machine-checkable.
			verification: expect.objectContaining({
				state: "unverifiable",
				checks: [],
				validation: [],
			}),
			// No machine-checkable requirement => unverifiable => inspect, never
			// reject and never a silent accept.
			gate: expect.objectContaining({
				decision: "inspect",
				policy: { requireExecutionCompleted: true, requireVerificationSatisfied: true },
				reasonCodes: ["verification-unverifiable"],
				checks: [
					expect.objectContaining({
						id: "gate:execution-status",
						decision: "satisfied",
						required: true,
					}),
					expect.objectContaining({
						id: "gate:verification-state",
						decision: "inspect",
						code: "verification-unverifiable",
					}),
				],
			}),
			// inspect => the lifecycle asks for higher-level inspection.
			orchestration: {
				action: "inspect",
				status: "INSPECTION_REQUIRED",
				reasonCode: "gate-inspection-required",
				reason: expect.any(String),
				gateReasonCodes: ["verification-unverifiable"],
			},
		});
	});

	test("the Worker prompt contains the TaskSpec explicitly", async () => {
		const { harness, captured } = makeHarness();
		await harness.run(spec({ goal: "UNIQUE_GOAL_MARKER" }));

		const prompt = captured.sessions[0]!.promptedTexts[0]!;
		expect(prompt).toContain("UNIQUE_GOAL_MARKER");
		expect(prompt).toContain("task-1");
		expect(prompt).toContain("src/thing.ts");
		expect(prompt).toContain("thing done");
	});

	test("the Worker session is created with an independent, empty session context", async () => {
		const { harness, captured } = makeHarness();
		await harness.run(spec());

		const options = captured.options[0]!;
		expect(options.sessionManager).toBeInstanceOf(SessionManager);
		// No Architect history can be present.
		expect(options.sessionManager!.buildSessionContext().messages).toHaveLength(0);
	});

	test("the Worker session loads no discovered extensions (recursion guard)", async () => {
		const { harness, captured } = makeHarness();
		await harness.run(spec());

		const extensions = captured.options[0]!.resourceLoader!.getExtensions().extensions;
		const discovered = extensions.filter((e) => !e.path.startsWith("<inline:"));
		// Nothing discovered means pi-local-worker itself can never be loaded into
		// its own Worker.
		expect(discovered).toHaveLength(0);
	});

	test("the Worker session loads exactly the inline work-boundary extension", async () => {
		const { harness, captured } = makeHarness();
		await harness.run(spec());

		const extensions = captured.options[0]!.resourceLoader!.getExtensions().extensions;
		const inline = extensions.filter((e) => e.path.startsWith("<inline:"));
		expect(inline.map((e) => e.path)).toEqual(["<inline:pi-local-worker-boundary>"]);
	});

	test("the Worker session is disposed after a successful run", async () => {
		const { harness, captured } = makeHarness();
		await harness.run(spec());
		expect(captured.sessions[0]!.disposeCount).toBe(1);
	});

	test("the single Worker slot is released after completion", async () => {
		const { harness } = makeHarness();
		expect(harness.isBusy).toBe(false);
		await harness.run(spec());
		expect(harness.isBusy).toBe(false);
	});
});

describe("WorkerHarness — single Worker at a time", () => {
	test("a second concurrent worker_run is rejected without touching the session", async () => {
		const gate = deferred();
		const { harness, captured } = makeHarness({ gate });

		const first = harness.run(spec({ taskId: "first" }));
		await tick();
		expect(harness.isBusy).toBe(true);
		expect(harness.activeTask).toBe("first");

		const second = await harness.run(spec({ taskId: "second" }));

		expect(second.status).toBe("error");
		expect(second.error).toContain("Worker is busy");
		expect(second.error).toContain("first");
		expect(second.taskId).toBe("second");
		// Still exactly one session created.
		expect(captured.sessions).toHaveLength(1);

		gate.resolve();
		const firstResult = await first;
		expect(firstResult.status).toBe("completed");
		expect(harness.isBusy).toBe(false);
	});

	test("a third call after release is accepted", async () => {
		const gate = deferred();
		const { harness } = makeHarness({ gate });

		const first = harness.run(spec({ taskId: "first" }));
		await tick();
		const rejected = await harness.run(spec({ taskId: "second" }));
		expect(rejected.status).toBe("error");

		gate.resolve();
		await first;

		const third = await harness.run(spec({ taskId: "third" }));
		expect(third.status).toBe("completed");
		expect(third.taskId).toBe("third");
	});
});

describe("WorkerHarness — outcome normalization", () => {
	test("aborted stopReason maps to status aborted", async () => {
		const { harness } = makeHarness({ stopReason: "aborted" });
		const result = await harness.run(spec());
		expect(result.status).toBe("aborted");
	});

	test("error stopReason maps to status error", async () => {
		const { harness } = makeHarness({ stopReason: "error" });
		const result = await harness.run(spec());
		expect(result.status).toBe("error");
		expect(result.error).toBeTruthy();
	});

	test("state.errorMessage maps to status error", async () => {
		const { harness } = makeHarness({ errorMessage: "provider exploded" });
		const result = await harness.run(spec());
		expect(result.status).toBe("error");
		expect(result.error).toContain("provider exploded");
	});

	test("no assistant message maps to status error", async () => {
		const { harness } = makeHarness({ emitAssistantMessage: false });
		const result = await harness.run(spec());
		expect(result.status).toBe("error");
		expect(result.error).toContain("no assistant message");
	});

	test("a run that never reaches agent_settled is an error", async () => {
		const { harness } = makeHarness({ emitSettled: false });
		const result = await harness.run(spec());
		expect(result.status).toBe("error");
		expect(result.error).toContain("agent_settled");
	});

	test("the Worker final response is returned as-is", async () => {
		const raw = "Line one.\n\nLine two with `code` and 100% fidelity.";
		const { harness } = makeHarness({ text: raw });
		const result = await harness.run(spec());
		expect(result.finalResponse).toBe(raw);
	});
});

describe("WorkerHarness — failure paths", () => {
	test("session creation failure becomes a structured error, not a throw", async () => {
		const harness = new WorkerHarness({
			cwd: process.cwd(),
			createSession: async () => {
				throw new Error("cannot build session");
			},
		});

		const result = await harness.run(spec());
		expect(result.status).toBe("error");
		expect(result.error).toContain("Worker session creation failed");
		expect(result.error).toContain("cannot build session");
		expect(harness.isBusy).toBe(false);
	});

	test("prompt failure becomes a structured error and still disposes the session", async () => {
		const { harness, captured } = makeHarness({ promptError: new Error("no auth") });
		const result = await harness.run(spec());

		expect(result.status).toBe("error");
		expect(result.error).toContain("Worker execution failed");
		expect(result.error).toContain("no auth");
		expect(captured.sessions[0]!.disposeCount).toBe(1);
		expect(harness.isBusy).toBe(false);
	});

	test("an unexpected throw outside the guarded paths is contained", async () => {
		// A model that cannot be resolved throws from buildSessionOptions(), which
		// sits outside the inner create-session guard. It must still come back as a
		// structured result rather than crashing the caller.
		const stubRuntime = { getModel: () => undefined } as unknown as ModelRuntime;
		const harness = new WorkerHarness({
			cwd: process.cwd(),
			provider: "no-such-provider",
			modelId: "no-such-model",
			modelRuntime: stubRuntime,
		});

		const result = await harness.run(spec());
		expect(result.status).toBe("error");
		expect(result.error).toContain("Unexpected Worker failure");
		expect(result.error).toContain("no-such-provider/no-such-model");
		expect(harness.isBusy).toBe(false);
	});
});

describe("WorkerHarness — external abort", () => {
	test("an already-aborted signal stops before the session is created", async () => {
		const controller = new AbortController();
		controller.abort();
		const { harness, captured } = makeHarness();

		const result = await harness.run(spec(), controller.signal);
		expect(result.status).toBe("aborted");
		expect(captured.sessions).toHaveLength(0);
	});

	test("aborting mid-run aborts the Worker session and reports aborted", async () => {
		const gate = deferred();
		const controller = new AbortController();
		const { harness, captured } = makeHarness({ gate });

		const running = harness.run(spec(), controller.signal);
		await tick();
		controller.abort();
		await tick();
		expect(captured.sessions[0]!.abortCount).toBe(1);

		gate.resolve();
		const result = await running;
		expect(result.status).toBe("aborted");
		expect(harness.isBusy).toBe(false);
	});
});
