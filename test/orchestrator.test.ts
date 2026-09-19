import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { evaluateGate, type GateEvidence, type GatePolicy } from "../src/gate.ts";
import {
	isReturned,
	orchestrate,
	requiresInspection,
	type OrchestrationDecision,
} from "../src/orchestrator.ts";
import type { WorkerStatus } from "../src/worker-harness.ts";

type VerifyState = "satisfied" | "unsatisfied" | "unverifiable";

/**
 * Step 10 — the Orchestrator is a total map over Gate output, and nothing else.
 *
 * Every case here builds a real GateEvidence with evaluateGate() rather than
 * hand-writing one, so the Orchestrator is tested against the shape the Gate
 * actually produces. A fixture that only looks plausible would let a real
 * mismatch through.
 */

function gateFor(
	status: WorkerStatus,
	state: VerifyState,
	policy?: GatePolicy,
): GateEvidence {
	return evaluateGate({ status, verification: { state } }, policy);
}

function decision(
	status: WorkerStatus,
	state: VerifyState,
	policy?: GatePolicy,
): OrchestrationDecision {
	return orchestrate({ gate: gateFor(status, state, policy) });
}

describe("Orchestrator: A — accept returns", () => {
	it("completed + satisfied + accept -> return", () => {
		const d = decision("completed", "satisfied");
		expect(d.action).toBe("return");
		expect(d.status).toBe("RETURNED");
		expect(d.reasonCode).toBe("gate-accepted");
		expect(isReturned(d)).toBe(true);
	});
});

describe("Orchestrator: B — reject returns, never retries", () => {
	it("completed + unsatisfied + reject -> return", () => {
		const d = decision("completed", "unsatisfied");
		expect(d.action).toBe("return");
		expect(d.status).toBe("RETURNED");
		expect(d.reasonCode).toBe("gate-rejected");
	});

	it("the reject reason names the absence of recovery", () => {
		// The reason text is part of the contract: a reader must not infer a retry
		// hook exists somewhere downstream.
		const d = decision("completed", "unsatisfied");
		expect(d.reason.toLowerCase()).toContain("retry");
	});

	it("reject is not represented as an error status", () => {
		const d = decision("completed", "unsatisfied");
		expect(d.status).not.toMatch(/error|fail/i);
		expect(d.action).not.toMatch(/error|fail/i);
	});
});

describe("Orchestrator: C — inspect is a first-class state", () => {
	it("completed + unverifiable + inspect -> inspect", () => {
		const d = decision("completed", "unverifiable");
		expect(d.action).toBe("inspect");
		expect(d.status).toBe("INSPECTION_REQUIRED");
		expect(d.reasonCode).toBe("gate-inspection-required");
		expect(requiresInspection(d)).toBe(true);
	});

	it("inspect is not an error", () => {
		const d = decision("completed", "unverifiable");
		expect(d.status).not.toMatch(/error|fail/i);
		expect(d.action).not.toMatch(/error|fail/i);
	});

	it("inspect does not mean the Orchestrator looked at anything", () => {
		// The reason must describe a requirement on a higher consumer, not an
		// action performed here.
		const d = decision("completed", "unverifiable");
		expect(d.reason).toMatch(/inspection is required/i);
	});
});

describe("Orchestrator: D/E/F — non-clean terminal states return", () => {
	for (const status of ["timeout", "aborted", "error"] as const) {
		it(`${status} + reject -> return`, () => {
			const d = decision(status, "unsatisfied");
			expect(d.action).toBe("return");
			expect(d.reasonCode).toBe("gate-rejected");
		});

		it(`${status} with no verification at all -> reject -> return`, () => {
			const d = orchestrate({
				gate: evaluateGate({ status, verification: undefined }),
			});
			expect(d.action).toBe("return");
			expect(d.reasonCode).toBe("gate-rejected");
		});
	}
});

describe("Orchestrator: G — consumes the Gate decision, never rebuilds it", () => {
	it("a policy that drops the verification requirement turns reject into return-as-accepted", () => {
		// Same Worker facts, different policy. The Orchestrator sees only the
		// resulting decision: unsatisfied verification now yields accept, so the
		// action follows the Gate rather than the verification state.
		const policy: GatePolicy = {
			requireExecutionCompleted: true,
			requireVerificationSatisfied: false,
		};
		const d = decision("completed", "unsatisfied", policy);
		expect(d.reasonCode).toBe("gate-accepted");
		expect(d.action).toBe("return");
	});

	it("a policy that keeps the execution requirement still rejects a timeout", () => {
		const policy: GatePolicy = {
			requireExecutionCompleted: true,
			requireVerificationSatisfied: false,
		};
		expect(decision("timeout", "satisfied", policy).reasonCode).toBe("gate-rejected");
	});

	it("a policy that drops both requirements accepts a timeout", () => {
		const policy: GatePolicy = {
			requireExecutionCompleted: false,
			requireVerificationSatisfied: false,
		};
		expect(decision("timeout", "unsatisfied", policy).reasonCode).toBe("gate-accepted");
	});

	it("the Orchestrator reads no verification field", () => {
		// The input type carries only `gate`. Passing a richer object changes
		// nothing, which is the structural proof that verification is not read.
		const gate = gateFor("completed", "unsatisfied");
		const lean = orchestrate({ gate });
		const padded = orchestrate({
			gate,
			status: "completed",
			verification: { state: "satisfied" },
		} as never);
		expect(padded).toEqual(lean);
	});
});

describe("Orchestrator: H — idempotence", () => {
	it("identical inputs give identical decisions across repeated calls", () => {
		for (const [status, state] of [
			["completed", "satisfied"],
			["completed", "unsatisfied"],
			["completed", "unverifiable"],
			["timeout", "satisfied"],
			["aborted", "unsatisfied"],
			["error", "unsatisfied"],
		] as const) {
			const runs = Array.from({ length: 5 }, () => decision(status, state));
			for (const run of runs.slice(1)) {
				expect(run).toEqual(runs[0]);
			}
		}
	});

	it("the decision contains no timestamp, counter or random component", () => {
		const d = decision("completed", "satisfied");
		expect(Object.keys(d).sort()).toEqual([
			"action",
			"gateReasonCodes",
			"reason",
			"reasonCode",
			"status",
		]);
	});
});

describe("Orchestrator: I — no Worker access", () => {
	const source = readFileSync(
		fileURLToPath(new URL("../src/orchestrator.ts", import.meta.url)),
		"utf8",
	);
	const imports = source
		.split("\n")
		.filter((line) => /^\s*import\b/.test(line) || /^\s*(?:from)\s+\"/.test(line))
		.join("\n");

	it("imports nothing at runtime — every import is type-only", () => {
		// A value import would hand the module a capability. `import type` is
		// erased by the compiler, so the emitted module imports nothing at all.
		expect(imports).not.toBe("");
		expect(imports).toMatch(/^import type /);
		expect(imports).not.toMatch(/^import\s+(?!type)/m);
	});

	it("no import of the harness, filesystem, Git, subprocess or model", () => {
		for (const banned of [
			"worker-harness",
			"node:fs",
			"node:child_process",
			"git-observer",
			"completion-verifier",
			"terminal-arbiter",
			"timeout",
			"watchdog",
			"session",
			"@earendil-works",
		]) {
			expect(imports, `import mentions ${banned}`).not.toContain(banned);
		}
	});

	it("the module body calls no I/O, clock or randomness function", () => {
		const body = source.slice(source.indexOf("export function orchestrate"));
		for (const banned of [
			"Date.",
			"new Date",
			"Math.random",
			"setTimeout",
			"setInterval",
			"fetch(",
			"process.",
			"execSync",
			"spawn",
			"readFileSync",
			"await ",
		]) {
			expect(body, `body contains ${banned}`).not.toContain(banned);
		}
	});

	it("the Gate import is type-only, so the Orchestrator cannot re-run policy", () => {
		expect(imports).not.toMatch(/import\s*\{[^}]*evaluateGate/);
	});
});

describe("Orchestrator: J — no mutation", () => {
	it("the GateEvidence is unchanged by orchestration", () => {
		const gate = gateFor("completed", "unsatisfied");
		const before = structuredClone(gate);
		orchestrate({ gate });
		expect(gate).toEqual(before);
	});

	it("the returned gateReasonCodes is a copy, not the Gate's own array", () => {
		const gate = gateFor("completed", "unsatisfied");
		const d = orchestrate({ gate });
		expect(d.gateReasonCodes).not.toBe(gate.reasonCodes);
		expect(d.gateReasonCodes).toEqual([...gate.reasonCodes]);
		// Mutating the decision must not reach back into the Gate's evidence.
		(d.gateReasonCodes as string[]).push("tampered");
		expect(gate.reasonCodes).not.toContain("tampered");
	});

	it("repeated calls do not accumulate into the input", () => {
		const gate = gateFor("completed", "unverifiable");
		const before = structuredClone(gate);
		for (let i = 0; i < 10; i++) orchestrate({ gate });
		expect(gate).toEqual(before);
	});
});

describe("Orchestrator: K — evidence preservation", () => {
	it("every Gate reason code survives into the decision", () => {
		const gate = gateFor("timeout", "unsatisfied");
		expect(gate.reasonCodes.length).toBeGreaterThan(0);
		expect(orchestrate({ gate }).gateReasonCodes).toEqual([...gate.reasonCodes]);
	});

	it("the low-level verification reason is never rewritten", () => {
		// §18: `verification-unsatisfied` must stay visible as itself. The
		// Orchestrator adds a code; it does not substitute one.
		const gate = gateFor("completed", "unsatisfied");
		expect(gate.reasonCodes).toContain("verification-unsatisfied");
		const d = orchestrate({ gate });
		expect(d.gateReasonCodes).toContain("verification-unsatisfied");
		expect(d.reasonCode).toBe("gate-rejected");
		expect(d.reasonCode).not.toBe("worker-failed");
	});

	it("all three Gate codes pass through on the multi-failure path", () => {
		const gate = gateFor("error", "unsatisfied");
		expect(orchestrate({ gate }).gateReasonCodes).toEqual([...gate.reasonCodes]);
		expect(new Set(orchestrate({ gate }).gateReasonCodes).size).toBe(
			gate.reasonCodes.length,
		);
	});

	it("the decision is additive: it never removes information the Gate carried", () => {
		for (const [status, state] of [
			["completed", "satisfied"],
			["completed", "unsatisfied"],
			["completed", "unverifiable"],
		] as const) {
			const gate = gateFor(status, state);
			const d = orchestrate({ gate });
			expect(d.gateReasonCodes.length).toBe(gate.reasonCodes.length);
		}
	});
});

describe("Orchestrator: vocabulary is closed and minimal", () => {
	it("the three Gate decisions map onto exactly two actions", () => {
		const actions = new Set(
			[
				decision("completed", "satisfied"),
				decision("completed", "unsatisfied"),
				decision("completed", "unverifiable"),
			].map((d) => d.action),
		);
		expect([...actions].sort()).toEqual(["inspect", "return"]);
	});

	it("every Gate decision has a mapping — the map is total", () => {
		for (const decisionValue of ["accept", "reject", "inspect"] as const) {
			const gate: GateEvidence = {
				decision: decisionValue,
				policy: { requireExecutionCompleted: true, requireVerificationSatisfied: true },
				checks: [],
				reasonCodes: [],
				reasons: [],
			};
			expect(() => orchestrate({ gate })).not.toThrow();
		}
	});

	it("an unknown Gate decision is not silently defaulted", () => {
		// The map is a Record over the closed union. A value outside it must be
		// visibly broken rather than quietly routed to `return`.
		const gate = { decision: "maybe", reasonCodes: [], checks: [] } as never;
		expect(() => orchestrate({ gate })).toThrow(TypeError);
	});
});
