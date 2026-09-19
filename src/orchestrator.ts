import type { GateDecision, GateEvidence, GateReasonCodeType } from "./gate.ts";

/**
 * Minimal Orchestrator (Step 10).
 *
 * The first component allowed to read Gate output as control flow. It maps a
 * closed three-value Gate decision onto a closed two-value lifecycle action. That
 * is the whole job.
 *
 *   Worker -> Evidence -> Verification -> Gate -> Orchestrator -> Architect
 *
 * Responsibility split, and this module holds exactly one line of it:
 *
 *   Worker         = execute
 *   Evidence       = observe
 *   Verification   = establish explicit conditions
 *   Gate           = apply policy
 *   Orchestrator   = select lifecycle action      <-- here
 *   Architect      = decide what the work means
 *
 * The Orchestrator may control lifecycle. It must not become the source of
 * semantic judgment. It does not know what the task was, what the Worker did, or
 * whether any of it was good. It reads `gate.decision` and returns an action.
 *
 * This module imports types only — no WorkerHarness, no filesystem, no Git, no
 * child process, no model, no session control. It has no capability to launch,
 * retry, repair, steer, abort, or inspect anything.
 */

/**
 * Lifecycle action.
 *
 * Two values, deliberately. A third (`stop`) was considered and rejected: no
 * existing policy produces it, so adding it would be speculative surface rather
 * than a capability anyone can call for.
 */
export type OrchestrationAction = "return" | "inspect";

/**
 * Lifecycle status corresponding to the action.
 *
 * Kept distinct from Worker execution status on purpose. `reject` is not an
 * error and `inspect` is not an error; collapsing either into an error state would
 * destroy the distinction Step 8 and Step 9 worked to establish.
 */
export type OrchestrationStatus = "RETURNED" | "INSPECTION_REQUIRED";

/**
 * Orchestration-level reason codes. Three, closed.
 *
 * These summarize *why this action was selected*. The Gate's own, more specific
 * codes are carried alongside unchanged (§18) — `verification-unsatisfied` is
 * never rewritten into something like `worker-failed`.
 */
export type OrchestrationReasonCode =
	| "gate-accepted"
	| "gate-rejected"
	| "gate-inspection-required";

/** The pure orchestration decision. */
export interface OrchestrationDecision {
	action: OrchestrationAction;
	status: OrchestrationStatus;
	reasonCode: OrchestrationReasonCode;
	reason: string;
	/**
	 * The Gate's reason codes, passed through verbatim.
	 *
	 * The Orchestrator adds no interpretation, so it adds no reasons of its own
	 * beyond naming why the action follows. Everything the Gate knew stays visible.
	 */
	gateReasonCodes: readonly GateReasonCodeType[];
}

/** The minimum the Orchestrator reads. */
export interface OrchestrationInput {
	gate: GateEvidence;
}

const ACTION_BY_DECISION: Record<
	GateDecision,
	{
		action: OrchestrationAction;
		status: OrchestrationStatus;
		reasonCode: OrchestrationReasonCode;
		reason: string;
	}
> = {
	accept: {
		action: "return",
		status: "RETURNED",
		reasonCode: "gate-accepted",
		reason:
			"Gate accepted. The Worker lifecycle is complete and the evidence package is returned to the Architect.",
	},
	reject: {
		action: "return",
		status: "RETURNED",
		reasonCode: "gate-rejected",
		reason:
			"Gate rejected. There is no automatic recovery in v0, so the complete evidence package is returned to the Architect unchanged. This is not a retry trigger.",
	},
	inspect: {
		action: "inspect",
		status: "INSPECTION_REQUIRED",
		reasonCode: "gate-inspection-required",
		reason:
			"Gate could not decide automatically. Higher-level inspection is required. The Orchestrator performs no inspection of its own.",
	},
};

/**
 * Total, deterministic mapping from Gate decision to lifecycle action.
 *
 *   accept  -> return
 *   reject  -> return
 *   inspect -> inspect
 *
 * `reject` returns rather than retrying because retry needs a retry policy, a
 * budget, task-revision rules, failure classification, scope preservation and
 * evidence invalidation. None of those exist yet, and each is its own design
 * problem. Returning preserves every fact so the Architect can make that call.
 *
 * Pure: no clock, no randomness, no I/O, no external state. Same input, same
 * output, always — and calling it twice on the same input changes nothing.
 */
export function orchestrate(input: OrchestrationInput): OrchestrationDecision {
	const mapped = ACTION_BY_DECISION[input.gate.decision];
	return {
		action: mapped.action,
		status: mapped.status,
		reasonCode: mapped.reasonCode,
		reason: mapped.reason,
		gateReasonCodes: [...input.gate.reasonCodes],
	};
}

/** True when the lifecycle is finished and the result is deliverable. */
export function isReturned(decision: OrchestrationDecision): boolean {
	return decision.action === "return";
}

/** True when a higher-level consumer must look before anything proceeds. */
export function requiresInspection(decision: OrchestrationDecision): boolean {
	return decision.action === "inspect";
}
