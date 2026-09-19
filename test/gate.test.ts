import { Value } from "typebox/value";
import { describe, expect, test } from "vitest";

import {
	aggregateGateChecks,
	DEFAULT_GATE_POLICY,
	evaluateGate,
	GatePolicySchema,
	type GateCheck,
	type GateInput,
	type GatePolicy,
} from "../src/gate.ts";

/**
 * Gate unit tests.
 *
 * The Gate is a pure function over already-established facts, so every case here
 * is a literal input and a literal decision. No harness, no Git, no subprocess.
 */

const input = (
	status: string,
	state: "satisfied" | "unsatisfied" | "unverifiable" | undefined,
): GateInput => ({ status, verification: state === undefined ? undefined : { state } });

const decision = (
	status: string,
	state: "satisfied" | "unsatisfied" | "unverifiable" | undefined,
	policy: GatePolicy = DEFAULT_GATE_POLICY,
) => evaluateGate(input(status, state), policy).decision;

const checkOf = (
	status: string,
	state: "satisfied" | "unsatisfied" | "unverifiable" | undefined,
	policy: GatePolicy = DEFAULT_GATE_POLICY,
	id: string,
) => evaluateGate(input(status, state), policy).checks.find((c) => c.id === id);

describe("A/B/C — completed execution", () => {
	test("A: completed + satisfied -> accept", () => {
		expect(decision("completed", "satisfied")).toBe("accept");
	});

	test("B: completed + unsatisfied -> reject", () => {
		expect(decision("completed", "unsatisfied")).toBe("reject");
	});

	test("C: completed + unverifiable -> inspect, NOT reject", () => {
		expect(decision("completed", "unverifiable")).toBe("inspect");
	});
});

describe("D/E/F/G — non-completed execution", () => {
	test("D: error + satisfied -> reject", () => {
		expect(decision("error", "satisfied")).toBe("reject");
	});

	test("E: aborted + satisfied -> reject", () => {
		expect(decision("aborted", "satisfied")).toBe("reject");
	});

	test("F: timeout + satisfied -> reject", () => {
		expect(decision("timeout", "satisfied")).toBe("reject");
	});

	test("G: timeout + unverifiable -> reject (execution requirement dominates)", () => {
		expect(decision("timeout", "unverifiable")).toBe("reject");
	});

	test("execution failure preserves the verification fact rather than overwriting it", () => {
		const evidence = evaluateGate(input("timeout", "satisfied"));
		expect(evidence.decision).toBe("reject");
		// The verification check is still recorded as satisfied. Rejection on
		// execution grounds does not rewrite what verification said.
		expect(checkOf("timeout", "satisfied", DEFAULT_GATE_POLICY, "gate:verification-state")?.decision).toBe(
			"satisfied",
		);
		expect(evidence.checks.find((c) => c.id === "gate:execution-status")?.decision).toBe(
			"unsatisfied",
		);
	});

	test("both reason codes surface when both dimensions fail", () => {
		const evidence = evaluateGate(input("timeout", "unsatisfied"));
		expect(evidence.decision).toBe("reject");
		expect(evidence.reasonCodes).toEqual(["execution-not-completed", "verification-unsatisfied"]);
	});
});

describe("H — no verification evidence", () => {
	test("completed + missing verification -> inspect", () => {
		expect(decision("completed", undefined)).toBe("inspect");
		expect(checkOf("completed", undefined, DEFAULT_GATE_POLICY, "gate:verification-state")?.code).toBe(
			"verification-missing",
		);
	});

	test("missing verification is never a reject", () => {
		expect(decision("completed", undefined)).not.toBe("reject");
	});

	test("timeout + missing verification -> reject, both failing facts reported", () => {
		const evidence = evaluateGate(input("timeout", undefined));
		expect(evidence.decision).toBe("reject");
		// Both required checks failed, so both codes are reported. The Gate does
		// not stop at the first failure; the full picture travels with the decision.
		expect(evidence.reasonCodes).toEqual([
			"execution-not-completed",
			"verification-missing",
		]);
	});
});

describe("I/J/K — aggregation over mixed checks", () => {
	test("I: unsatisfied dominates unverifiable", () => {
		const checks: GateCheck[] = [
			{ id: "a", kind: "execution-status", decision: "satisfied", required: true, code: "accepted" },
			{
				id: "b",
				kind: "verification-state",
				decision: "unsatisfied",
				required: true,
				code: "verification-unsatisfied",
			},
			{
				id: "c",
				kind: "verification-state",
				decision: "inspect",
				required: true,
				code: "verification-unverifiable",
			},
		];
		expect(aggregateGateChecks(checks)).toBe("reject");
	});

	test("J: unverifiable dominates satisfied", () => {
		const checks: GateCheck[] = [
			{ id: "a", kind: "execution-status", decision: "satisfied", required: true, code: "accepted" },
			{
				id: "c",
				kind: "verification-state",
				decision: "inspect",
				required: true,
				code: "verification-unverifiable",
			},
		];
		expect(aggregateGateChecks(checks)).toBe("inspect");
	});

	test("K: all satisfied -> accept", () => {
		const checks: GateCheck[] = [
			{ id: "a", kind: "execution-status", decision: "satisfied", required: true, code: "accepted" },
			{
				id: "b",
				kind: "verification-state",
				decision: "satisfied",
				required: true,
				code: "accepted",
			},
		];
		expect(aggregateGateChecks(checks)).toBe("accept");
	});

	test("non-required checks do not influence the decision", () => {
		const checks: GateCheck[] = [
			{ id: "a", kind: "execution-status", decision: "satisfied", required: true, code: "accepted" },
			{
				id: "b",
				kind: "verification-state",
				decision: "unsatisfied",
				required: false,
				code: "verification-unsatisfied",
			},
		];
		expect(aggregateGateChecks(checks)).toBe("accept");
	});

	test("no required checks -> accept", () => {
		expect(
			aggregateGateChecks([
				{
					id: "a",
					kind: "execution-status",
					decision: "unsatisfied",
					required: false,
					code: "execution-not-completed",
				},
			]),
		).toBe("accept");
	});
});

describe("L — policy is actually injected, not hard-coded", () => {
	test("requireExecutionCompleted=false: timeout can be accepted", () => {
		const policy: GatePolicy = {
			requireExecutionCompleted: false,
			requireVerificationSatisfied: true,
		};
		expect(decision("timeout", "satisfied", policy)).toBe("accept");
		// The failing fact is still recorded, just not required.
		const exec = checkOf("timeout", "satisfied", policy, "gate:execution-status");
		expect(exec?.decision).toBe("unsatisfied");
		expect(exec?.required).toBe(false);
	});

	test("requireVerificationSatisfied=false: unverifiable can be accepted", () => {
		const policy: GatePolicy = {
			requireExecutionCompleted: true,
			requireVerificationSatisfied: false,
		};
		expect(decision("completed", "unverifiable", policy)).toBe("accept");
		expect(checkOf("completed", "unverifiable", policy, "gate:verification-state")?.required).toBe(
			false,
		);
	});

	test("requireVerificationSatisfied=false: unsatisfied verification is tolerated", () => {
		const policy: GatePolicy = {
			requireExecutionCompleted: true,
			requireVerificationSatisfied: false,
		};
		expect(decision("completed", "unsatisfied", policy)).toBe("accept");
	});

	test("both relaxed: everything accepts", () => {
		const policy: GatePolicy = {
			requireExecutionCompleted: false,
			requireVerificationSatisfied: false,
		};
		for (const status of ["completed", "error", "aborted", "timeout"]) {
			for (const state of ["satisfied", "unsatisfied", "unverifiable", undefined] as const) {
				expect(decision(status, state, policy)).toBe("accept");
			}
		}
	});

	test("the same input yields different decisions under different policies", () => {
		const strict = decision("timeout", "satisfied", DEFAULT_GATE_POLICY);
		const relaxed = decision("timeout", "satisfied", {
			requireExecutionCompleted: false,
			requireVerificationSatisfied: true,
		});
		expect(strict).toBe("reject");
		expect(relaxed).toBe("accept");
	});

	test("the policy in the evidence reflects what was actually applied", () => {
		const policy: GatePolicy = {
			requireExecutionCompleted: false,
			requireVerificationSatisfied: true,
		};
		expect(evaluateGate(input("timeout", "satisfied"), policy).policy).toEqual(policy);
	});
});

describe("Reason codes", () => {
	test("accepted when both required checks pass", () => {
		expect(evaluateGate(input("completed", "satisfied")).reasonCodes).toEqual(["accepted"]);
	});

	test("every reason code has human-readable text", () => {
		const cases: Array<[string, "satisfied" | "unsatisfied" | "unverifiable" | undefined]> = [
			["completed", "satisfied"],
			["completed", "unsatisfied"],
			["completed", "unverifiable"],
			["completed", undefined],
			["timeout", "satisfied"],
		];
		for (const [status, state] of cases) {
			const evidence = evaluateGate(input(status, state));
			expect(evidence.reasons.length).toBe(evidence.reasonCodes.length);
			for (const reason of evidence.reasons) {
				expect(reason.length).toBeGreaterThan(10);
			}
		}
	});

	test("reason codes are a closed small set", () => {
		const seen = new Set<string>();
		for (const status of ["completed", "error", "aborted", "timeout"]) {
			for (const state of ["satisfied", "unsatisfied", "unverifiable", undefined] as const) {
				for (const code of evaluateGate(input(status, state)).reasonCodes) seen.add(code);
			}
		}
		expect([...seen].sort()).toEqual([
			"accepted",
			"execution-not-completed",
			"verification-missing",
			"verification-unsatisfied",
			"verification-unverifiable",
		]);
	});
});

describe("Forbidden vocabulary", () => {
	test("no quality/score/confidence/success/correctness field exists anywhere", () => {
		const evidence = evaluateGate(input("completed", "satisfied"));
		const serialized = JSON.stringify(evidence).toLowerCase();
		for (
			const banned of [
				"quality",
				"score",
				"confidence",
				"success",
				"good",
				"bad",
				"correct",
				"incorrect",
				"workerquality",
				"tasksuccess",
			]
		) {
			expect(serialized).not.toContain(banned);
		}
	});

	test("decision is restricted to the three-value vocabulary", () => {
		const decisions = new Set<string>();
		for (const status of ["completed", "error", "aborted", "timeout"]) {
			for (const state of ["satisfied", "unsatisfied", "unverifiable", undefined] as const) {
				for (const requireExec of [true, false]) {
					for (const requireVerify of [true, false]) {
						decisions.add(
							evaluateGate(input(status, state), {
								requireExecutionCompleted: requireExec,
								requireVerificationSatisfied: requireVerify,
							}).decision,
						);
					}
				}
			}
		}
		expect([...decisions].sort()).toEqual(["accept", "inspect", "reject"]);
	});
});

describe("Policy schema", () => {
	test("the schema validates a well-formed policy", () => {
		expect(
			Value.Check(GatePolicySchema, {
				requireExecutionCompleted: true,
				requireVerificationSatisfied: false,
			}),
		).toBe(true);
	});

	test("the schema rejects a malformed policy", () => {
		expect(Value.Check(GatePolicySchema, { requireExecutionCompleted: "yes" })).toBe(false);
		expect(Value.Check(GatePolicySchema, {})).toBe(false);
	});
});

describe("Determinism", () => {
	test("identical inputs produce identical evidence", () => {
		const a = JSON.stringify(evaluateGate(input("timeout", "satisfied")));
		const b = JSON.stringify(evaluateGate(input("timeout", "satisfied")));
		expect(a).toBe(b);
	});

	test("evaluation does not mutate its input", () => {
		const original: GateInput = { status: "timeout", verification: { state: "satisfied" } };
		const snapshot = JSON.stringify(original);
		evaluateGate(original, DEFAULT_GATE_POLICY);
		expect(JSON.stringify(original)).toBe(snapshot);
	});

	test("evaluation does not mutate the supplied policy", () => {
		const policy: GatePolicy = { requireExecutionCompleted: false, requireVerificationSatisfied: true };
		evaluateGate(input("timeout", "satisfied"), policy);
		expect(policy).toEqual({ requireExecutionCompleted: false, requireVerificationSatisfied: true });
	});
});
