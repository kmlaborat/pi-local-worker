import { createCodingTools, createPowerShellTool, createReadOnlyTools } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";

import type { TaskSpec } from "../src/task-spec.ts";
import {
	BUILTIN_READ_ONLY_TOOLS,
	BUILTIN_WRITE_CAPABLE_TOOLS,
	BoundaryRecorder,
	createWorkBoundaryExtension,
	evaluateToolPolicy,
	isReadOnlyWorkType,
	type WorkType,
} from "../src/work-boundary.ts";
import { WorkerHarness } from "../src/worker-harness.ts";
import { FakeWorkerSession, toolCallHandlerFromBoundaryExtension } from "./helpers/fake-session.ts";

const READ_ONLY: WorkType[] = ["investigate", "review", "verify"];
const WRITABLE: WorkType[] = ["implement", "refactor", "test"];

function spec(workType: WorkType, taskId = "boundary-task"): TaskSpec {
	return {
		taskId,
		goal: "boundary check",
		scope: [],
		workType,
		completionCriteria: ["done"],
	};
}

describe("work boundary — tool-name conformance", () => {
	test("read-only tool list matches pi's actual read-only built-ins", () => {
		const piReadOnly = createReadOnlyTools(process.cwd())
			.map((t) => t.name)
			.sort();
		expect([...BUILTIN_READ_ONLY_TOOLS].sort()).toEqual(piReadOnly);
	});

	test("write-capable list covers every mutating built-in pi ships", () => {
		const mutating = new Set(
			createCodingTools(process.cwd())
				.map((t) => t.name)
				.filter((name) => !BUILTIN_READ_ONLY_TOOLS.includes(name)),
		);
		mutating.add(createPowerShellTool(process.cwd()).name);

		expect([...mutating].sort()).toEqual([...BUILTIN_WRITE_CAPABLE_TOOLS].sort());
	});

	test("no tool is classified as both read-only and write-capable", () => {
		const overlap = BUILTIN_WRITE_CAPABLE_TOOLS.filter((name) => BUILTIN_READ_ONLY_TOOLS.includes(name));
		expect(overlap).toEqual([]);
	});
});

describe("work boundary — policy", () => {
	test("investigate / review / verify are read-only work types", () => {
		for (const workType of READ_ONLY) {
			expect(isReadOnlyWorkType(workType)).toBe(true);
		}
		for (const workType of WRITABLE) {
			expect(isReadOnlyWorkType(workType)).toBe(false);
		}
	});

	test("read-only work blocks every write-capable built-in", () => {
		for (const workType of READ_ONLY) {
			for (const tool of BUILTIN_WRITE_CAPABLE_TOOLS) {
				const decision = evaluateToolPolicy(workType, tool);
				expect(decision.allowed, `${workType}/${tool}`).toBe(false);
				expect(decision.reason).toContain(tool);
			}
		}
	});

	test("read-only work allows read and search tools", () => {
		for (const workType of READ_ONLY) {
			for (const tool of BUILTIN_READ_ONLY_TOOLS) {
				expect(evaluateToolPolicy(workType, tool).allowed, `${workType}/${tool}`).toBe(true);
			}
		}
	});

	test("writable work blocks nothing", () => {
		for (const workType of WRITABLE) {
			for (const tool of [...BUILTIN_WRITE_CAPABLE_TOOLS, ...BUILTIN_READ_ONLY_TOOLS, "mystery_tool"]) {
				expect(evaluateToolPolicy(workType, tool).allowed, `${workType}/${tool}`).toBe(true);
			}
		}
	});

	test("unknown tools fail closed for read-only work", () => {
		for (const workType of READ_ONLY) {
			const decision = evaluateToolPolicy(workType, "some_custom_tool");
			expect(decision.allowed).toBe(false);
			expect(decision.reason).toContain("fail closed");
		}
	});
});

describe("work boundary — extension factory contract", () => {
	test("the factory registers a tool_call handler that blocks and records", () => {
		const recorder = new BoundaryRecorder();
		const handler = toolCallHandlerFromBoundaryExtension(
			createWorkBoundaryExtension("investigate", recorder) as never,
		);

		const blocked = handler({ toolName: "write", toolCallId: "c1", input: {} });
		expect(blocked?.block).toBe(true);
		expect(blocked?.reason).toContain("write");

		expect(recorder.count).toBe(1);
		expect(recorder.violations[0]).toMatchObject({
			toolName: "write",
			toolCallId: "c1",
			workType: "investigate",
		});
	});

	test("allowed tools produce no block and no violation", () => {
		const recorder = new BoundaryRecorder();
		const handler = toolCallHandlerFromBoundaryExtension(createWorkBoundaryExtension("review", recorder) as never);

		expect(handler({ toolName: "read", toolCallId: "c2", input: {} })).toBeUndefined();
		expect(handler({ toolName: "grep", toolCallId: "c3", input: {} })).toBeUndefined();
		expect(recorder.count).toBe(0);
	});
});

describe("work boundary — enforced through the harness", () => {
	/**
	 * Pull the `tool_call` handler that the harness actually registered into the
	 * Worker's own resource loader, and wire it into the fake's veto-then-execute
	 * replay. This exercises the harness's real boundary extension and the real
	 * recorder that ends up in `result.boundary`, not a parallel copy.
	 */
	async function runWithTools(workType: WorkType, tools: Array<{ toolCallId: string; toolName: string }>) {
		let fake: FakeWorkerSession | undefined;

		const harness = new WorkerHarness({
			cwd: process.cwd(),
			createSession: async (options) => {
				const loader = options.resourceLoader;
				if (!loader) throw new Error("harness built the session without a resource loader");

				const inline = loader.getExtensions().extensions.find((e) => e.path.startsWith("<inline:"));
				if (!inline) throw new Error("no inline boundary extension was loaded into the Worker");

				const handlers = inline.handlers.get("tool_call") ?? [];
				if (handlers.length === 0) throw new Error("boundary extension registered no tool_call handler");

				const session = new FakeWorkerSession({
					tools,
					text: "finished",
					toolCallHandler: async (event) => {
						let blocked: { block?: boolean; reason?: string } | undefined;
						for (const handler of handlers) {
							const result = (await handler(event)) as { block?: boolean; reason?: string } | undefined;
							if (result?.block) blocked = result;
						}
						return blocked;
					},
				});
				fake = session;
				return { session: session as never };
			},
		});

		const result = await harness.run(spec(workType));
		if (!fake) throw new Error("Worker session was never created");
		return { fake, result };
	}

	test.each(["investigate", "review", "verify"] as WorkType[])(
		"%s blocks a write tool before it executes",
		async (workType) => {
			const { fake, result } = await runWithTools(workType, [{ toolCallId: "w1", toolName: "write" }]);

			expect(fake.blockedTools).toEqual(["write"]);
			expect(fake.executedTools).toEqual([]);
			expect(result.boundary.readOnly).toBe(true);
			expect(result.boundary.violations).toHaveLength(1);
			expect(result.boundary.violations[0]?.toolName).toBe("write");
			// A blocked tool is not a crash.
			expect(result.status).toBe("completed");
			expect(result.error).toBeNull();
		},
	);

	test("an implement task still executes the write tool", async () => {
		const { fake, result } = await runWithTools("implement", [
			{ toolCallId: "w1", toolName: "write" },
			{ toolCallId: "e1", toolName: "edit" },
		]);

		expect(fake.executedTools).toEqual(["write", "edit"]);
		expect(fake.blockedTools).toEqual([]);
		expect(result.boundary.violations).toHaveLength(0);
		expect(result.boundary.readOnly).toBe(false);
	});

	test("read-only work still runs read and search tools", async () => {
		const { fake, result } = await runWithTools("investigate", [
			{ toolCallId: "r1", toolName: "read" },
			{ toolCallId: "g1", toolName: "grep" },
			{ toolCallId: "f1", toolName: "find" },
			{ toolCallId: "l1", toolName: "ls" },
		]);

		expect(fake.executedTools).toEqual(["read", "grep", "find", "ls"]);
		expect(fake.blockedTools).toEqual([]);
		expect(result.boundary.violations).toHaveLength(0);
	});

	test("multiple blocked calls are all reported", async () => {
		const { fake, result } = await runWithTools("review", [
			{ toolCallId: "w1", toolName: "write" },
			{ toolCallId: "b1", toolName: "bash" },
			{ toolCallId: "r1", toolName: "read" },
		]);

		expect(fake.blockedTools).toEqual(["write", "bash"]);
		expect(fake.executedTools).toEqual(["read"]);
		expect(result.boundary.violations.map((v) => v.toolName)).toEqual(["write", "bash"]);
		expect(result.status).toBe("completed");
	});

	test("a blocked tool still emits tool_execution_end and clears pendingToolCalls", async () => {
		const { fake } = await runWithTools("verify", [{ toolCallId: "w1", toolName: "write" }]);

		expect(fake.emittedEvents.filter((e) => e === "tool_execution_start")).toHaveLength(1);
		expect(fake.emittedEvents.filter((e) => e === "tool_execution_end")).toHaveLength(1);
		expect(fake.state.pendingToolCalls.size).toBe(0);
	});
});
