import { Type, type Static } from "typebox";

/**
 * Deterministic Gate (Step 9).
 *
 * The Gate is the first decision layer, and it is a *decision function*, not an
 * orchestrator. It reads facts that already exist — execution status and
 * verification evidence — and assigns a policy outcome.
 *
 *   Worker -> Evidence -> Verification -> Gate
 *
 * Information flows one way. There is no reverse control path: the Gate cannot
 * retry, repair, steer, abort, expand scope, touch the filesystem, inspect Git,
 * run commands, or call a model. It has no capability to do any of those things,
 * which is what makes it both pure and safe.
 *
 * Verification answers "did this explicit machine-checkable condition hold?".
 * The Gate answers "given the execution and verification evidence, what state does
 * the configured policy assign?". Those are different questions and stay separate.
 */

export type GateDecision = "accept" | "reject" | "inspect";

/**
 * Stable machine-readable reason codes.
 *
 * Codes rather than prose so a consumer can branch on them. The accompanying
 * `reason` text is generated from a fixed table here — never by a model.
 */
export const GateReasonCode = Type.Union([
	Type.Literal("accepted"),
	Type.Literal("execution-not-completed"),
	Type.Literal("verification-unsatisfied"),
	Type.Literal("verification-unverifiable"),
	Type.Literal("verification-missing"),
]);

export type GateReasonCodeType = Static<typeof GateReasonCode>;

/**
 * Explicit Gate policy.
 *
 * Two independent requirements, each individually switchable. Deliberately not a
 * rule language: no AND/OR/NOT, no nesting, no expression strings. Policy is
 * injectable so tests can prove the decision follows the policy rather than a
 * hard-coded default, but it is not arbitrarily customizable.
 */
export const GatePolicySchema = Type.Object({
	/**
	 * When true, a Worker whose execution status is not `completed` is rejected
	 * regardless of how good its evidence looks.
	 *
	 * This is why `timeout + verification satisfied` rejects: the run did not
	 * finish, and the policy says finishing is required.
	 */
	requireExecutionCompleted: Type.Boolean({ default: true }),

	/**
	 * When true, verification must come out `satisfied` for an automatic accept.
	 *
	 * `unsatisfied` rejects. `unverifiable` — including the case where no
	 * machine-checkable requirement was ever supplied — goes to `inspect` rather
	 * than `reject`. Absent evidence is not evidence of failure, and accepting it
	 * silently would accept work with no checkable basis at all.
	 */
	requireVerificationSatisfied: Type.Boolean({ default: true }),
});

export type GatePolicy = Static<typeof GatePolicySchema>;

/** The shipped default: both requirements enforced. */
export const DEFAULT_GATE_POLICY: GatePolicy = {
	requireExecutionCompleted: true,
	requireVerificationSatisfied: true,
};

/**
 * One policy check against one input dimension.
 *
 * `required` records whether this check participates in aggregation. A check the
 * policy does not require is still recorded, so the observed fact is preserved
 * even when it does not drive the decision.
 */
export interface GateCheck {
	id: string;
	kind: "execution-status" | "verification-state";
	decision: "satisfied" | "unsatisfied" | "inspect";
	required: boolean;
	/** Stable reason code for this check's outcome. */
	code: GateReasonCodeType;
	expected?: unknown;
	observed?: unknown;
	reason?: string;
}

/**
 * Structured Gate outcome.
 *
 * Never a bare decision string: the checks, reason codes and human-readable
 * reasons all travel together so a downstream consumer can explain the outcome
 * without re-deriving it.
 *
 * Contains no quality score, no confidence value, and no judgment about whether
 * the Worker did good work. It states only what the policy concluded.
 */
export interface GateEvidence {
	decision: GateDecision;
	policy: GatePolicy;
	checks: readonly GateCheck[];
	reasonCodes: readonly GateReasonCodeType[];
	reasons: readonly string[];
}

/** The minimum the Gate reads. Nothing else is observable from here. */
export interface GateInput {
	status: string;
	verification:
		| {
				state: "satisfied" | "unsatisfied" | "unverifiable";
		  }
		| undefined;
}

const REASON_TEXT: Record<GateReasonCodeType, string> = {
	accepted: "Execution and verification both satisfy the configured Gate policy.",
	"execution-not-completed":
		"Policy requires completed execution, but the Worker did not complete.",
	"verification-unsatisfied":
		"Policy requires satisfied verification, but a required verification condition was unsatisfied.",
	"verification-unverifiable":
		"Verification could not be established from the available evidence, so automatic acceptance is not possible.",
	"verification-missing":
		"No verification evidence was produced, so automatic acceptance is not possible.",
};

/**
 * Aggregation over required checks (§13).
 *
 *   any required reject -> reject
 *   else any required inspect -> inspect
 *   else -> accept
 *
 * This is policy aggregation over recorded checks, not semantic evaluation.
 */
export function aggregateGateChecks(
	checks: readonly GateCheck[],
): GateDecision {
	const required = checks.filter((c) => c.required);
	if (required.some((c) => c.decision === "unsatisfied")) return "reject";
	if (required.some((c) => c.decision === "inspect")) return "inspect";
	return "accept";
}

/**
 * Evaluate the Gate.
 *
 * Pure: takes facts in, returns a decision out. No I/O, no mutation, no clock,
 * no randomness. Both checks are always evaluated and recorded so the result
 * preserves the full picture — a rejection on execution grounds does not erase
 * the fact that verification was satisfied.
 */
export function evaluateGate(
	input: GateInput,
	policy: GatePolicy = DEFAULT_GATE_POLICY,
): GateEvidence {
	const checks: GateCheck[] = [];

	// --- Execution dimension ---
	const executionSatisfied = input.status === "completed";
	checks.push({
		id: "gate:execution-status",
		kind: "execution-status",
		decision: executionSatisfied ? "satisfied" : "unsatisfied",
		required: policy.requireExecutionCompleted,
		code: executionSatisfied ? "accepted" : "execution-not-completed",
		expected: { status: "completed" },
		observed: { status: input.status },
		reason: executionSatisfied
			? `Execution status is "${input.status}".`
			: `Execution status is "${input.status}", not "completed".`,
	});

	// --- Verification dimension ---
	const verificationCheck = evaluateVerificationCheck(
		input.verification,
		policy.requireVerificationSatisfied,
	);
	checks.push(verificationCheck);

	const decision = aggregateGateChecks(checks);

	// Reasons: every check that contributed, plus the terminal code.
	const contributing = checks.filter(
		(c) => c.required && c.code !== "accepted",
	);
	const reasonCodes: GateReasonCodeType[] =
		contributing.length > 0 ? contributing.map((c) => c.code) : ["accepted"];

	return {
		decision,
		policy: { ...policy },
		checks,
		reasonCodes,
		reasons: reasonCodes.map((code) => REASON_TEXT[code]),
	};
}

function evaluateVerificationCheck(
	verification: GateInput["verification"],
	required: boolean,
): GateCheck {
	if (verification === undefined) {
		return {
			id: "gate:verification-state",
			kind: "verification-state",
			// Missing evidence is unknown, not failure. Inspect, never reject.
			decision: "inspect",
			required,
			code: "verification-missing",
			expected: { state: "satisfied" },
			observed: { state: undefined },
			reason: "No verification evidence was produced for this run.",
		};
	}

	switch (verification.state) {
		case "satisfied":
			return {
				id: "gate:verification-state",
				kind: "verification-state",
				decision: "satisfied",
				required,
				code: "accepted",
				expected: { state: "satisfied" },
				observed: { state: "satisfied" },
				reason: "All required verification conditions were satisfied.",
			};
		case "unsatisfied":
			return {
				id: "gate:verification-state",
				kind: "verification-state",
				decision: "unsatisfied",
				required,
				code: "verification-unsatisfied",
				expected: { state: "satisfied" },
				observed: { state: "unsatisfied" },
				reason: "A required verification condition was unsatisfied.",
			};
		case "unverifiable":
			return {
				id: "gate:verification-state",
				kind: "verification-state",
				// unverifiable is NOT unsatisfied. It means "not established",
				// which under this policy means a human looks.
				decision: "inspect",
				required,
				code: "verification-unverifiable",
				expected: { state: "satisfied" },
				observed: { state: "unverifiable" },
				reason:
					"Verification could not be established from the available evidence. " +
					"This is not a failure of the Worker.",
			};
		default:
			return {
				id: "gate:verification-state",
				kind: "verification-state",
				decision: "inspect",
				required,
				code: "verification-unverifiable",
				expected: { state: "satisfied" },
				observed: { state: verification.state },
				reason: "Verification reported an unrecognized state.",
			};
	}
}
