import { createCodingTools, createPowerShellTool, createReadOnlyTools } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";

import {
	isReadOnlyWorkType,
	READ_ONLY_WORK_TYPES,
	type TaskSpec,
	type WorkType,
} from "../src/task-spec.ts";
import { deriveRequirements } from "../src/completion-verifier.ts";
import {
	BUILTIN_READ_ONLY_TOOLS,
	BUILTIN_WRITE_CAPABLE_TOOLS,
	BoundaryRecorder,
	createWorkBoundaryExtension,
	evaluateToolPolicy,
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

// ---------------------------------------------------------------------------
// Single-source guarantee (audit fix A-1).
//
// The Step 3 work boundary and the Step 8 completion verifier classify work
// types by the same rule through different mechanisms: the boundary blocks
// write-capable tools before they run, the verifier applies an implicit
// `no-changes` invariant. These tests pin the two to the same list so a future
// edit to one cannot silently diverge from the other.
// ---------------------------------------------------------------------------
describe("single source: work boundary and completion verifier agree", () => {
	const ALL_WORK_TYPES: WorkType[] = [
		"investigate",
		"review",
		"test",
		"implement",
		"refactor",
		"verify",
	];

	test("READ_ONLY_WORK_TYPES is the only read-only list, and it is typed as WorkType[]", () => {
		// Typed, not `string[]`: a loose list would let a non-work-type slip in
		// and silently never match.
		const list: readonly WorkType[] = READ_ONLY_WORK_TYPES;
		expect([...list]).toEqual(["investigate", "review", "verify"]);
		// Every member is a real work type declared by the schema.
		for (const wt of READ_ONLY_WORK_TYPES) {
			expect(ALL_WORK_TYPES).toContain(wt);
		}
	});

	test("isReadOnlyWorkType partitions exactly READ_ONLY_WORK_TYPES", () => {
		const readOnly = ALL_WORK_TYPES.filter(isReadOnlyWorkType);
		expect(readOnly).toEqual([...READ_ONLY_WORK_TYPES]);
	});

	test("the boundary blocks write-capable tools for exactly the read-only set", () => {
		for (const workType of ALL_WORK_TYPES) {
			const blocksAnything = BUILTIN_WRITE_CAPABLE_TOOLS.some(
				(tool) => !evaluateToolPolicy(workType, tool).allowed,
			);
			expect(blocksAnything).toBe(isReadOnlyWorkType(workType));
		}
	});

	test("the verifier applies the implicit no-changes invariant for exactly the read-only set", () => {
		for (const workType of ALL_WORK_TYPES) {
			const { requirements } = deriveRequirements({ workType });
			const hasImplicitNoChanges = requirements.some((r) => r.kind === "no-changes");
			expect(hasImplicitNoChanges).toBe(isReadOnlyWorkType(workType));
		}
	});

	test("both layers classify every work type identically", () => {
		// The direct cross-check: for each work type, "the boundary would block a
		// write tool" must equal "the verifier expects no changes".
		for (const workType of ALL_WORK_TYPES) {
			const boundarySaysReadOnly = !evaluateToolPolicy(workType, "write").allowed;
			const verifierSaysReadOnly = deriveRequirements({ workType }).requirements.some(
				(r) => r.kind === "no-changes",
			);
			expect(boundarySaysReadOnly).toBe(verifierSaysReadOnly);
		}
	});

	test("completion-verifier.ts declares no read-only list of its own", async () => {
		// Structural proof of the single source: the verifier module must not
		// contain its own READ_ONLY_WORK_TYPES definition.
		const source = await import("node:fs").then((fs) =>
			fs.readFileSync(new URL("../src/completion-verifier.ts", import.meta.url), "utf8"),
		);
		const definitions = source.match(/(const|let|var)\s+READ_ONLY_WORK_TYPES\s*:/g) ?? [];
		expect(definitions).toEqual([]);
	});
});
