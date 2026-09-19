import { Type, type Static } from "typebox";

import { VerificationRequirementSchema } from "./verification.ts";

/**
 * Minimal internal TaskSpec representation (SPEC v0.1 §6).
 *
 * The TaskSpec is the ONLY thing that crosses the Architect -> Worker boundary.
 * It must be self-contained: a Worker that needs a fact must find it here or
 * discover it with its own tools.
 *
 * Required fields are the minimum needed to dispatch a task. The remaining
 * fields come straight from the Spec and are optional in v0 so that callers
 * are not forced into a large validation framework.
 */
export const TaskSpecSchema = Type.Object({
	/** Stable identifier for the task. Used in results and (later) logs. */
	taskId: Type.String({ description: "Stable task identifier, chosen by the Architect." }),

	/** SPEC 6.1 - what the Worker must accomplish. */
	goal: Type.String({ description: "What the Worker must accomplish. One or two sentences." }),

	/** SPEC 6.3 - files / directories / symbols the Worker may touch. */
	scope: Type.Array(Type.String(), {
		description: "Files, directories, symbols or areas the Worker may inspect or modify.",
	}),

	/**
	 * SPEC 6.5 - kind of work.
	 *
	 * Not merely descriptive: `workType` drives the Step 3 tool boundary and the
	 * Step 8 implicit `no-changes` invariant. See READ_ONLY_WORK_TYPES below.
	 */
	workType: Type.Union(
		[
			Type.Literal("investigate"),
			Type.Literal("review"),
			Type.Literal("test"),
			Type.Literal("implement"),
			Type.Literal("refactor"),
			Type.Literal("verify"),
		],
		{ description: "Kind of work. See SPEC 6.5." },
	),

	/** SPEC 6.9 - explicit conditions for a complete task. */
	completionCriteria: Type.Array(Type.String(), {
		description: "Explicit conditions that define a complete task.",
	}),

	/**
	 * Machine-checkable completion requirements (Step 8).
	 *
	 * This is the authoritative input to deterministic verification, and the
	 * only one. It supersedes the SPEC v0.1 §6.7 `validation` field, which
	 * described the same thing in prose and was never wired to the verifier: a
	 * task listing `validation: ["npm test"]` ran no check and reported
	 * `unverifiable`, silently. Express the same intent as
	 * `{ kind: "command", argv: ["npm", "test"] }` here instead.
	 *
	 * `completionCriteria` stays as human-readable context and is explicitly NOT
	 * interpreted: a task with only prose criteria verifies as `unverifiable`,
	 * never as satisfied.
	 */
	completionChecks: Type.Optional(
		Type.Array(VerificationRequirementSchema, {
			description:
				"Structured, machine-checkable completion requirements. Absent means nothing is deterministically verifiable.",
		}),
	),

	/** SPEC 6.2 - references to authoritative documents. */
	relevantSpec: Type.Optional(Type.String({ description: "References to specs / docs / issues." })),

	/** SPEC 6.4 - conditions that must already hold. */
	preconditions: Type.Optional(Type.Array(Type.String())),

	/** SPEC 6.6 - required testing approach, when applicable. */
	testRequirements: Type.Optional(Type.String({ description: "Required testing approach (e.g. TDD)." })),

	/** SPEC 6.8 - restrictions on the implementation. */
	implementationConstraints: Type.Optional(Type.Array(Type.String())),

	/** SPEC 6.10 - changes the Worker must not make. */
	forbiddenChanges: Type.Optional(Type.Array(Type.String())),

	/** SPEC 6.11 - what the Worker should report back. */
	expectedReport: Type.Optional(Type.Array(Type.String())),
});

export type TaskSpec = Static<typeof TaskSpecSchema>;

/**
 * The closed set of work kinds a TaskSpec may declare (SPEC v0.1 §6.5).
 *
 * Derived from the schema rather than written out again, so the type and the wire
 * format cannot drift. Declared here rather than in the enforcement layer because
 * `workType` is a TaskSpec field: every consumer that reasons about it sits
 * above this module, and putting the type anywhere higher would force this module
 * to depend upward.
 */
export type WorkType = TaskSpec["workType"];

/**
 * Work types that must not modify the workspace.
 *
 * SINGLE SOURCE OF TRUTH. Both the Step 3 work boundary, which blocks
 * write-capable tools before they execute, and the Step 8 completion verifier,
 * which applies an implicit `no-changes` invariant, read this one list.
 *
 * They are deliberately not each given their own copy. The two layers classify the
 * same run the same way through different mechanisms, and a drift between them
 * would let a task be enforced as read-only while being verified as writable, or
 * the reverse. The two are pinned together by a test rather than by convention.
 */
export const READ_ONLY_WORK_TYPES: readonly WorkType[] = ["investigate", "review", "verify"];

/** True when `workType` must leave the workspace unmodified. */
export function isReadOnlyWorkType(workType: WorkType): boolean {
	return READ_ONLY_WORK_TYPES.includes(workType);
}

/**
 * Render the TaskSpec into the single user message that starts the Worker.
 *
 * The Worker has no Architect conversation history, so every field has to be
 * spelled out here. Kept as a plain markdown block: no templating engine, no
 * per-field strategy.
 */
export function renderTaskSpecPrompt(spec: TaskSpec): string {
	const lines: string[] = [];

	lines.push("# Task");
	lines.push("");
	lines.push(`Task ID: ${spec.taskId}`);
	lines.push(`Work type: ${spec.workType}`);
	lines.push("");
	lines.push("## Goal");
	lines.push(spec.goal);
	lines.push("");
	lines.push("## Scope");
	lines.push(...bulletList(spec.scope));

	if (spec.relevantSpec) {
		lines.push("");
		lines.push("## Relevant Spec");
		lines.push(spec.relevantSpec);
	}

	if (spec.preconditions && spec.preconditions.length > 0) {
		lines.push("");
		lines.push("## Preconditions");
		lines.push(...bulletList(spec.preconditions));
	}

	if (spec.testRequirements) {
		lines.push("");
		lines.push("## Test / TDD Requirements");
		lines.push(spec.testRequirements);
	}

	if (spec.implementationConstraints && spec.implementationConstraints.length > 0) {
		lines.push("");
		lines.push("## Implementation Constraints");
		lines.push(...bulletList(spec.implementationConstraints));
	}

	if (spec.forbiddenChanges && spec.forbiddenChanges.length > 0) {
		lines.push("");
		lines.push("## Forbidden Changes");
		lines.push(...bulletList(spec.forbiddenChanges));
	}

	lines.push("");
	lines.push("## Completion Criteria");
	lines.push(...bulletList(spec.completionCriteria));

	if (spec.completionChecks && spec.completionChecks.length > 0) {
		lines.push("");
		lines.push("## Machine-Checked Completion Requirements");
		lines.push(
			"These are verified deterministically against the workspace and validation",
		);
		lines.push("evidence after you finish. They are stated here so you can see the target.");
		lines.push(...spec.completionChecks.map((check) => `- ${describeCheck(check)}`));
	}

	if (spec.expectedReport && spec.expectedReport.length > 0) {
		lines.push("");
		lines.push("## Expected Report");
		lines.push(...bulletList(spec.expectedReport));
	}

	lines.push("");
	lines.push(
		"You are working as an isolated Worker. You have no access to the Architect's " +
			"conversation. Everything you know about this task is written above. When you " +
			"are done, produce the final report as your last assistant message.",
	);

	return lines.join("\n");
}

function bulletList(items: readonly string[]): string[] {
	return items.length > 0 ? items.map((item) => `- ${item}`) : ["- (none)"];
}

/**
 * Render one structured requirement as prompt text.
 *
 * Presentation only. The verifier reads the structured value, never this string.
 */
function describeCheck(check: Record<string, unknown>): string {
	const kind = String(check.kind ?? "unknown");
	const id = String(check.id ?? "");
	switch (kind) {
		case "changed-files": {
			const paths = (check.paths as string[] | undefined) ?? [];
			const mode = (check.mode as string | undefined) ?? "exact";
			return `[${id}] changed-files (${mode}): ${JSON.stringify(paths)}`;
		}
		case "forbidden-files":
			return `[${id}] forbidden-files: ${JSON.stringify((check.paths as string[] | undefined) ?? [])}`;
		case "no-changes":
			return `[${id}] no-changes: the Worker must induce no workspace changes`;
		case "command":
		case "test":
			return `[${id}] ${kind}: ${JSON.stringify((check.argv as string[] | undefined) ?? [])}`;
		default:
			return `[${id}] ${kind}`;
	}
}
