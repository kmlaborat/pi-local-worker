import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// `WorkType`, `READ_ONLY_WORK_TYPES` and `isReadOnlyWorkType` are defined once,
// in task-spec.ts, and imported here rather than re-declared. This Step 3
// enforcement layer and the Step 8 verifier both classify work types by the same
// rule through different mechanisms, so they read the same list. Consumers import
// those names from task-spec.ts directly; this module deliberately does not
// re-export them, so there is exactly one place to import each from.
import { isReadOnlyWorkType, type WorkType } from "./task-spec.ts";

/**
 * Built-in pi 0.85.1 tools whose purpose is to modify the workspace.
 *
 * Names taken from `createAllTools()` in
 * `packages/coding-agent/src/core/tools/index.ts`:
 *   read, bash, powershell, edit, write, grep, find, ls
 *
 * `bash` and `powershell` are included because they can mutate the workspace
 * with routinely available commands, so a "must not modify files" boundary cannot
 * hold while they are permitted. They are listed explicitly rather than inferred
 * from name matching.
 */
export const BUILTIN_WRITE_CAPABLE_TOOLS: readonly string[] = ["write", "edit", "bash", "powershell"];

/** Built-in pi tools that cannot modify the workspace. */
export const BUILTIN_READ_ONLY_TOOLS: readonly string[] = ["read", "grep", "find", "ls"];

export interface ToolPolicyDecision {
	allowed: boolean;
	reason?: string;
}

/**
 * Decide whether `toolName` may execute for a task of `workType`.
 *
 * Explicit table lookup. Unknown tools are treated as write-capable for read-only
 * work (fail closed) instead of being waved through.
 */
export function evaluateToolPolicy(workType: WorkType, toolName: string): ToolPolicyDecision {
	if (!isReadOnlyWorkType(workType)) {
		return { allowed: true };
	}

	if (BUILTIN_READ_ONLY_TOOLS.includes(toolName)) {
		return { allowed: true };
	}

	if (BUILTIN_WRITE_CAPABLE_TOOLS.includes(toolName)) {
		return {
			allowed: false,
			reason:
				`Tool "${toolName}" can modify the workspace, but task "${workType}" ` +
				`(taskId in this Worker) is read-only. Blocked before execution.`,
		};
	}

	return {
		allowed: false,
		reason:
			`Tool "${toolName}" is not classified as read-only, and task "${workType}" ` +
			"is read-only. Blocked before execution (fail closed for unknown tools).",
	};
}

export interface BoundaryViolation {
	toolName: string;
	toolCallId: string;
	workType: WorkType;
	reason: string;
}

/** Collects blocked tool calls so they can be reported in the Worker result. */
export class BoundaryRecorder {
	private readonly _violations: BoundaryViolation[] = [];

	public get violations(): readonly BoundaryViolation[] {
		return this._violations;
	}

	public record(violation: BoundaryViolation): void {
		this._violations.push(violation);
	}

	public get count(): number {
		return this._violations.length;
	}
}

/**
 * Build the pi extension factory that enforces the TaskSpec work boundary.
 *
 * Registered into the Worker session as an inline extension factory, so it uses
 * the native `tool_call` veto (`{ block: true, reason }`) inside the Worker's
 * own extension runner. No fs patching, no post-hoc git inspection.
 *
 * Note on pi's ordering: `tool_execution_start` fires *before* the veto runs, so
 * a blocked tool still emits a matching `tool_execution_end` carrying an error
 * result. That is expected and must not be read as a successful execution.
 */
export function createWorkBoundaryExtension(
	workType: WorkType,
	recorder: BoundaryRecorder,
): (pi: ExtensionAPI) => void {
	return (pi: ExtensionAPI) => {
		pi.on("tool_call", (event) => {
			const decision = evaluateToolPolicy(workType, event.toolName);
			if (decision.allowed) {
				return undefined;
			}
			recorder.record({
				toolName: event.toolName,
				toolCallId: event.toolCallId,
				workType,
				reason: decision.reason ?? "Blocked by the TaskSpec work boundary.",
			});
			return { block: true, reason: decision.reason ?? "Blocked by the TaskSpec work boundary." };
		});
	};
}
