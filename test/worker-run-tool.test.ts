import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { describe, expect, test } from "vitest";

import extensionFactory, { createWorkerRunTool } from "../src/index.ts";
import { TaskSpecSchema, type TaskSpec } from "../src/task-spec.ts";
import { WorkerHarness } from "../src/worker-harness.ts";
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
import { FakeWorkerSession } from "./helpers/fake-session.ts";
import { cleanWorkspace, unchangedEvidence } from "./helpers/fake-git.ts";

/** The v0 tool path never touches the ExtensionContext. */
const ctxStub = {} as ExtensionContext;

const validSpec: TaskSpec = {
	taskId: "task-tool-1",
	goal: "Verify the tool translation layer.",
	scope: ["src/index.ts"],
	workType: "verify",
	completionCriteria: ["a structured result comes back"],
};

function harnessWithFakeSession(fake: FakeWorkerSession): WorkerHarness {
	// Deterministic evidence: never let the real repository's state leak in.
	const git = cleanWorkspace();
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return new WorkerHarness({
		cwd: git.dir,
		gitRunner: git.runner,
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		createSession: async () => ({ session: fake as any }),
	});
}

describe("worker_run tool definition", () => {
	test("the extension registers exactly one tool named worker_run", () => {
		const registered: ToolDefinition[] = [];
		const pi = {
			registerTool: (tool: ToolDefinition) => {
				registered.push(tool);
			},
		} as unknown as ExtensionAPI;

		extensionFactory(pi);

		expect(registered).toHaveLength(1);
		expect(registered[0]!.name).toBe("worker_run");
		expect(typeof registered[0]!.execute).toBe("function");
	});

	test("the tool parameters are the TaskSpec schema", () => {
		const tool = createWorkerRunTool(harnessWithFakeSession(new FakeWorkerSession()));
		expect(Value.Check(tool.parameters, validSpec)).toBe(true);
		expect(Value.Check(tool.parameters, { taskId: "x" })).toBe(false);
		expect(Value.Check(TaskSpecSchema, validSpec)).toBe(true);
	});

	test("the tool blocks concurrent execution by declaring sequential execution", () => {
		const tool = createWorkerRunTool(harnessWithFakeSession(new FakeWorkerSession()));
		expect(tool.executionMode).toBe("sequential");
	});
});

describe("worker_run tool execution", () => {
	test("returns the Worker result as JSON text plus structured details", async () => {
		const fake = new FakeWorkerSession({ text: "worker says hello" });
		const tool = createWorkerRunTool(harnessWithFakeSession(fake));

		const result = await tool.execute("tc-1", validSpec, undefined, undefined, ctxStub);

		expect(result.content).toHaveLength(1);
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(JSON.parse(text)).toEqual({
			taskId: "task-tool-1",
			status: "completed",
			finalResponse: "worker says hello",
			error: null,
			finalState: "FINISHED",
			// validSpec is workType "verify", which is read-only.
			boundary: { readOnly: true, violations: [] },
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
			// Evidence survives the JSON round-trip the tool performs.
			workspaceEvidence: unchangedEvidence(),
			// workType "verify" is read-only, so the implicit no-changes invariant
			// applies and the clean workspace satisfies it.
			verification: expect.objectContaining({
				state: "satisfied",
				checks: [
					expect.objectContaining({
						id: "worktype-default:no-changes",
						kind: "no-changes",
						state: "satisfied",
					}),
				],
			}),
			// Both required checks satisfied => accept.
			gate: expect.objectContaining({
				decision: "accept",
				reasonCodes: ["accepted"],
				checks: [
					expect.objectContaining({
						id: "gate:execution-status",
						decision: "satisfied",
						required: true,
					}),
					expect.objectContaining({
						id: "gate:verification-state",
						decision: "satisfied",
						code: "accepted",
					}),
				],
			}),
			// accept => return the evidence package to the Architect.
			orchestration: {
				action: "return",
				status: "RETURNED",
				reasonCode: "gate-accepted",
				reason: expect.any(String),
				gateReasonCodes: ["accepted"],
			},
		});
		expect(result.details).toMatchObject({ taskId: "task-tool-1", status: "completed" });
		expect(fake.disposeCount).toBe(1);
	});

	test("a busy Worker surfaces as a structured error result", async () => {
		const gate = { resolve: () => undefined as void };
		const gatePromise = new Promise<void>((resolve) => {
			gate.resolve = resolve;
		});
		const fake = new FakeWorkerSession({ gate: gatePromise });
		const harness = harnessWithFakeSession(fake);
		const tool = createWorkerRunTool(harness);

		const first = tool.execute("tc-1", validSpec, undefined, undefined, ctxStub);
		await new Promise((r) => setTimeout(r, 0));

		const secondRaw = await tool.execute("tc-2", { ...validSpec, taskId: "task-tool-2" }, undefined, undefined, ctxStub);
		const second = JSON.parse((secondRaw.content[0] as { type: "text"; text: string }).text);

		expect(second.taskId).toBe("task-tool-2");
		expect(second.status).toBe("error");
		expect(second.error).toContain("Worker is busy");

		gate.resolve();
		const firstRaw = await first;
		expect(JSON.parse((firstRaw.content[0] as { type: "text"; text: string }).text).status).toBe("completed");
	});
});
