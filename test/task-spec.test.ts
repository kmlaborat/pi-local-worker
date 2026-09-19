import { Value } from "typebox/value";
import { describe, expect, test } from "vitest";

import { TaskSpecSchema, renderTaskSpecPrompt, type TaskSpec } from "../src/task-spec.ts";

function minimalSpec(overrides: Partial<TaskSpec> = {}): TaskSpec {
	return {
		taskId: "task-42",
		goal: "Make the parser accept trailing commas.",
		scope: ["src/parser.ts", "test/parser.test.ts"],
		workType: "implement",
		completionCriteria: ["npm test passes", "trailing comma accepted"],
		...overrides,
	};
}

describe("TaskSpec schema", () => {
	test("accepts the minimal required shape", () => {
		expect(Value.Check(TaskSpecSchema, minimalSpec())).toBe(true);
	});

	test("requires taskId, goal, scope, workType and completionCriteria", () => {
		const required = ["taskId", "goal", "scope", "workType", "completionCriteria"];
		for (const field of required) {
			const spec = minimalSpec() as Record<string, unknown>;
			delete spec[field];
			expect(Value.Check(TaskSpecSchema, spec)).toBe(false);
		}
	});

	test("rejects an unknown workType", () => {
		expect(Value.Check(TaskSpecSchema, minimalSpec({ workType: "yolo" as TaskSpec["workType"] }))).toBe(false);
	});

	test("has no `validation` field: SPEC 6.7 is expressed via completionChecks", () => {
		// The prose `validation` field was removed. It described the same thing
		// `completionChecks` now expresses machine-checkably, and was never wired
		// to the verifier. Pinning its absence here so it cannot come back as a
		// second, inert way to say the same thing.
		expect(Object.keys(TaskSpecSchema.properties)).not.toContain("validation");
		const spec = minimalSpec();
		expect("validation" in spec).toBe(false);
	});

	test("accepts every optional SPEC 6 field", () => {
		const spec = minimalSpec({
			relevantSpec: "docs/SPEC_v0.1.md §6",
			preconditions: ["deps installed"],
			testRequirements: "TDD required",
			implementationConstraints: ["no new deps"],
			forbiddenChanges: ["do not touch package.json"],
			expectedReport: ["summary + changed files"],
		});
		expect(Value.Check(TaskSpecSchema, spec)).toBe(true);
	});
});

describe("renderTaskSpecPrompt", () => {
	test("renders every required field explicitly", () => {
		const prompt = renderTaskSpecPrompt(minimalSpec());
		expect(prompt).toContain("task-42");
		expect(prompt).toContain("Make the parser accept trailing commas.");
		expect(prompt).toContain("src/parser.ts");
		expect(prompt).toContain("test/parser.test.ts");
		expect(prompt).toContain("implement");
		expect(prompt).toContain("npm test passes");
		expect(prompt).toContain("trailing comma accepted");
	});

	test("renders all optional SPEC 6 sections when present", () => {
		const prompt = renderTaskSpecPrompt(
			minimalSpec({
				relevantSpec: "RELEVANT_SPEC_MARKER",
				preconditions: ["PRECONDITION_MARKER"],
				testRequirements: "TEST_REQ_MARKER",
				implementationConstraints: ["IMPL_CONSTRAINT_MARKER"],
				forbiddenChanges: ["FORBIDDEN_MARKER"],
				expectedReport: ["EXPECTED_REPORT_MARKER"],
			}),
		);

		for (const marker of [
			"RELEVANT_SPEC_MARKER",
			"PRECONDITION_MARKER",
			"TEST_REQ_MARKER",
			"IMPL_CONSTRAINT_MARKER",
			"FORBIDDEN_MARKER",
			"EXPECTED_REPORT_MARKER",
		]) {
			expect(prompt).toContain(marker);
		}
	});

	test("omits optional sections that are absent", () => {
		const prompt = renderTaskSpecPrompt(minimalSpec());
		expect(prompt).not.toContain("## Forbidden Changes");
		expect(prompt).not.toContain("## Expected Report");
		expect(prompt).not.toContain("## Test / TDD Requirements");
	});

	test("states that the Worker has no access to the Architect conversation", () => {
		const prompt = renderTaskSpecPrompt(minimalSpec());
		expect(prompt).toMatch(/no access to the Architect/i);
	});
});
