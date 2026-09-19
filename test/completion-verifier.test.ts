import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
	deriveRequirements,
	verifyRequirements,
	type VerifyOptions,
} from "../src/completion-verifier.ts";
import {
	aggregateStates,
	spawnCommandRunner,
	type VerificationRequirement,
	type VerificationState,
} from "../src/verification.ts";
import { createFakeCommandRunner, evidenceWith } from "./helpers/fake-command.ts";

function verify(
	requirements: readonly VerificationRequirement[],
	paths: string[],
	extra: Partial<VerifyOptions> = {},
) {
	const fake = createFakeCommandRunner(extraNotes());
	return verifyRequirements({
		requirements,
		workspaceEvidence: evidenceWith(paths),
		runner: fake.runner,
		cwd: process.cwd(),
		commandTimeoutMs: 1_000,
		...extra,
	});
}

function extraNotes() {
	return [
		{ argv: ["npm", "test"], result: { exitCode: 0 } },
		{ argv: ["npm", "run", "typecheck"], result: { exitCode: 0 } },
		{ argv: ["npm", "run", "lint"], result: { exitCode: 1, stderr: "lint failed" } },
	];
}

const stateOf = (e: { checks: readonly { id: string; state: VerificationState }[] }, id: string) =>
	e.checks.find((c) => c.id === id)?.state;

describe("A/B/C — changed-files", () => {
	test("A: exact match -> satisfied", () => {
		const e = verify(
			[{ id: "cf", kind: "changed-files", paths: ["a.ts", "b.ts"], mode: "exact" }],
			["a.ts", "b.ts"],
		);
		expect(stateOf(e, "cf")).toBe("satisfied");
		expect(e.state).toBe("satisfied");
	});

	test("B: exact with an extra observed file -> unsatisfied", () => {
		const e = verify(
			[{ id: "cf", kind: "changed-files", paths: ["a.ts", "b.ts"], mode: "exact" }],
			["a.ts", "b.ts", "c.ts"],
		);
		expect(stateOf(e, "cf")).toBe("unsatisfied");
		expect(JSON.stringify(e.checks[0]!.observed)).toContain("c.ts");
		expect(e.checks[0]!.reason).toContain("Unexpected: [c.ts]");
	});

	test("B2: exact with a missing observed file -> unsatisfied", () => {
		const e = verify(
			[{ id: "cf", kind: "changed-files", paths: ["a.ts", "b.ts"], mode: "exact" }],
			["a.ts"],
		);
		expect(stateOf(e, "cf")).toBe("unsatisfied");
		expect(e.checks[0]!.reason).toContain("Missing: [b.ts]");
	});

	test("C: includes mode tolerates extra observed files", () => {
		const e = verify(
			[{ id: "cf", kind: "changed-files", paths: ["a.ts"], mode: "includes" }],
			["a.ts", "b.ts"],
		);
		expect(stateOf(e, "cf")).toBe("satisfied");
	});

	test("C2: includes mode still fails when an expected path is absent", () => {
		const e = verify(
			[{ id: "cf", kind: "changed-files", paths: ["a.ts", "z.ts"], mode: "includes" }],
			["a.ts", "b.ts"],
		);
		expect(stateOf(e, "cf")).toBe("unsatisfied");
		expect(e.checks[0]!.reason).toContain("z.ts");
	});

	test("changed-files compares the Worker-induced set, not the whole repo diff", () => {
		// The evidence view only carries Worker-induced changes, so a pre-existing
		// dirty file that the Worker never touched cannot appear here.
		const e = verify(
			[{ id: "cf", kind: "changed-files", paths: ["worker.ts"], mode: "exact" }],
			["worker.ts"],
		);
		expect(stateOf(e, "cf")).toBe("satisfied");
	});
});

describe("D/E — forbidden-files", () => {
	test("D: forbidden path untouched -> satisfied", () => {
		const e = verify(
			[{ id: "fb", kind: "forbidden-files", paths: ["secret.ts"] }],
			["allowed.ts"],
		);
		expect(stateOf(e, "fb")).toBe("satisfied");
	});

	test("E: forbidden path changed -> unsatisfied, violating path reported", () => {
		const e = verify(
			[{ id: "fb", kind: "forbidden-files", paths: ["secret.ts", "other.ts"] }],
			["allowed.ts", "secret.ts"],
		);
		expect(stateOf(e, "fb")).toBe("unsatisfied");
		expect(e.checks[0]!.observed).toMatchObject({ forbiddenPathsChanged: ["secret.ts"] });
	});

	test("E2: forbidden with an empty change set -> satisfied", () => {
		const e = verify([{ id: "fb", kind: "forbidden-files", paths: ["secret.ts"] }], []);
		expect(stateOf(e, "fb")).toBe("satisfied");
	});
});

describe("F/G/H — no-changes", () => {
	test("F: clean baseline, no Worker change -> satisfied", () => {
		const e = verify([{ id: "nc", kind: "no-changes" }], []);
		expect(stateOf(e, "nc")).toBe("satisfied");
	});

	test("G: pre-existing dirty baseline, Worker changes nothing -> satisfied", () => {
		// The Step 7 contract: "no changes" means no WORKER-induced changes.
		// Pre-existing dirt lives in the baseline summary, not the change set.
		const e = verify([{ id: "nc", kind: "no-changes" }], []);
		expect(stateOf(e, "nc")).toBe("satisfied");
		expect(e.checks[0]!.reason).toContain("pre-existing dirt is not counted");
	});

	test("H: Worker modification -> unsatisfied", () => {
		const e = verify([{ id: "nc", kind: "no-changes" }], ["touched.ts"]);
		expect(stateOf(e, "nc")).toBe("unsatisfied");
		expect(e.checks[0]!.observed).toMatchObject({ workerChangedFileCount: 1 });
	});
});

describe("I/J — nothing machine-checkable", () => {
	test("I: no structured requirement -> unverifiable", () => {
		const e = verify([], ["anything.ts"]);
		expect(e.state).toBe("unverifiable");
		expect(e.checks).toEqual([]);
	});

	test("J: natural-language completion criteria only -> unverifiable", () => {
		const { requirements, notes } = deriveRequirements({
			workType: "implement",
			completionCriteria: ["Make the implementation robust and production ready."],
		});
		expect(requirements).toEqual([]);
		expect(notes.join(" ")).toMatch(/not machine-checkable/);

		const e = verify(requirements, ["whatever.ts"]);
		expect(e.state).toBe("unverifiable");
	});

	test("J2: prose is never reinterpreted into a rule", () => {
		// "changed src/a.ts" reads like a checkable statement but is still prose.
		const { requirements } = deriveRequirements({
			workType: "implement",
			completionCriteria: ["changed src/a.ts"],
		});
		expect(requirements).toEqual([]);
	});
});

describe("K — evidence unavailable", () => {
	test("every workspace-dependent check becomes unverifiable", () => {
		const reqs: VerificationRequirement[] = [
			{ id: "cf", kind: "changed-files", paths: ["a.ts"], mode: "exact" },
			{ id: "fb", kind: "forbidden-files", paths: ["b.ts"] },
			{ id: "nc", kind: "no-changes" },
		];
		const e = verifyRequirements({
			requirements: reqs,
			workspaceEvidence: evidenceWith([], "unavailable"),
			runner: createFakeCommandRunner().runner,
			cwd: process.cwd(),
			commandTimeoutMs: 1_000,
		});
		expect(stateOf(e, "cf")).toBe("unverifiable");
		expect(stateOf(e, "fb")).toBe("unverifiable");
		expect(stateOf(e, "nc")).toBe("unverifiable");
		expect(e.state).toBe("unverifiable");
		// Explicitly not a Worker failure.
		expect(e.checks.map((c) => c.reason).join(" ")).toContain("not a failure of the Worker");
	});

	test("missing evidence object is treated as unavailable, not as empty", () => {
		const e = verifyRequirements({
			requirements: [{ id: "nc", kind: "no-changes" }],
			workspaceEvidence: undefined,
			runner: createFakeCommandRunner().runner,
			cwd: process.cwd(),
			commandTimeoutMs: 1_000,
		});
		expect(stateOf(e, "nc")).toBe("unverifiable");
	});
});

describe("L/M/N/O — validation commands", () => {
	test("L: exit 0 -> satisfied", () => {
		const e = verify([{ id: "v", kind: "command", argv: ["npm", "test"] }], []);
		expect(stateOf(e, "v")).toBe("satisfied");
		expect(e.validation[0]).toMatchObject({ exitCode: 0, state: "satisfied" });
	});

	test("M: nonzero exit -> unsatisfied, and NOT a Worker error", () => {
		const e = verify([{ id: "v", kind: "command", argv: ["npm", "run", "lint"] }], []);
		expect(stateOf(e, "v")).toBe("unsatisfied");
		expect(e.validation[0]!.exitCode).toBe(1);
		expect(e.validation[0]!.reason).toContain("not a Worker execution error");
	});

	test("N: command cannot be launched -> unverifiable, not unsatisfied", () => {
		const fake = createFakeCommandRunner([]);
		const e = verifyRequirements({
			requirements: [{ id: "v", kind: "command", argv: ["definitely-not-installed", "--version"] }],
			workspaceEvidence: evidenceWith([]),
			runner: fake.runner,
			cwd: process.cwd(),
			commandTimeoutMs: 1_000,
		});
		expect(stateOf(e, "v")).toBe("unverifiable");
		expect(e.validation[0]!.exitCode).toBeNull();
	});

	test("N2: empty argv -> unverifiable", () => {
		const e = verify([{ id: "v", kind: "command", argv: [] as unknown as string[] }], []);
		expect(stateOf(e, "v")).toBe("unverifiable");
	});

	test("O: timeout -> unverifiable with timeout evidence", () => {
		const fake = createFakeCommandRunner([
			{
				argv: ["npm", "test"],
				result: { exitCode: null, timedOut: true, stderr: "killed after timeout" },
			},
		]);
		const e = verifyRequirements({
			requirements: [{ id: "v", kind: "command", argv: ["npm", "test"] }],
			workspaceEvidence: evidenceWith([]),
			runner: fake.runner,
			cwd: process.cwd(),
			commandTimeoutMs: 250,
		});
		expect(stateOf(e, "v")).toBe("unverifiable");
		expect(e.validation[0]!.timedOut).toBe(true);
		expect(e.validation[0]!.reason).toContain("timed out after 250ms");
	});

	test("O2: the timeout actually reaches the runner", () => {
		const fake = createFakeCommandRunner([{ argv: ["npm", "test"], result: { exitCode: 0 } }]);
		verifyRequirements({
			requirements: [{ id: "v", kind: "command", argv: ["npm", "test"], timeoutMs: 777 }],
			workspaceEvidence: evidenceWith([]),
			runner: fake.runner,
			cwd: "/base/cwd",
			commandTimeoutMs: 1_000,
		});
		// Per-command override wins over the harness default.
		expect(fake.calls[0]!.options.timeoutMs).toBe(777);
		expect(fake.calls[0]!.options.cwd).toBe("/base/cwd");
	});

	test("REGRESSION: shell metacharacters in argv are literal, not composed", async () => {
		// §26 safety: `npm test && rm ...` style composition must be impossible.
		// The runner uses spawnSync with shell:false, so "&&" is passed through as
		// an ordinary argument. The proof is that the would-be second command never
		// runs: its side effect (a written file) does not appear.
		const marker = join(tmpdir(), `pilw-shell-probe-${process.pid}.txt`);
		try {
			rmSync(marker, { force: true });
			const second = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'composed')`;
			const result = spawnCommandRunner.run(
				[process.execPath, "-e", "process.exit(0)", "&&", process.execPath, "-e", second],
				{ cwd: tmpdir(), timeoutMs: 10_000 },
			);
			// Only the first command ran, and it exited 0.
			expect(result.started).toBe(true);
			expect(result.exitCode).toBe(0);
			// No shell composition: the second command never executed.
			expect(existsSync(marker)).toBe(false);
		} finally {
			rmSync(marker, { force: true });
		}
	});

	test("test kind behaves identically to command", () => {
		const a = verify([{ id: "t", kind: "test", argv: ["npm", "test"] }], []);
		expect(stateOf(a, "t")).toBe("satisfied");
		expect(a.validation[0]!.argv).toEqual(["npm", "test"]);
	});
});

describe("P — aggregation", () => {
	test("any unsatisfied dominates unverifiable", () => {
		expect(
			aggregateStates(["satisfied", "unverifiable", "unsatisfied"] as VerificationState[]),
		).toBe("unsatisfied");
	});

	test("unverifiable dominates satisfied", () => {
		expect(aggregateStates(["satisfied", "unverifiable"])).toBe("unverifiable");
	});

	test("all satisfied -> satisfied", () => {
		expect(aggregateStates(["satisfied", "satisfied"])).toBe("satisfied");
	});

	test("empty -> unverifiable, never satisfied", () => {
		expect(aggregateStates([])).toBe("unverifiable");
	});

	test("mixed workspace + command checks aggregate deterministically", () => {
		const e = verify(
			[
				{ id: "ok", kind: "no-changes" },
				{ id: "cmd", kind: "command", argv: ["npm", "test"] },
			],
			[],
		);
		expect(e.state).toBe("satisfied");
	});
});

describe("U — path semantics", () => {
	test("Unicode and spaced paths compare exactly", () => {
		const paths = ["docs/ユニコード.md", "my reports/q1 final.md"];
		const e = verify(
			[{ id: "cf", kind: "changed-files", paths, mode: "exact" }],
			paths,
		);
		expect(stateOf(e, "cf")).toBe("satisfied");
	});

	test("a near-miss path is not treated as a match", () => {
		const e = verify(
			[{ id: "cf", kind: "changed-files", paths: ["docs/unicode.md"], mode: "exact" }],
			["docs/Unicode.md"],
		);
		expect(stateOf(e, "cf")).toBe("unsatisfied");
	});

	test("forbidden matching is exact, not prefix-based", () => {
		const e = verify(
			[{ id: "fb", kind: "forbidden-files", paths: ["src/app.ts"] }],
			["src/app.ts.bak"],
		);
		expect(stateOf(e, "fb")).toBe("satisfied");
	});
});

describe("V/W — invalid requirements", () => {
	test("V: duplicate ids are rejected as unverifiable", () => {
		const e = verify(
			[
				{ id: "dup", kind: "no-changes" },
				{ id: "dup", kind: "no-changes" },
			],
			[],
		);
		const config = e.checks.find((c) => c.id === "config:duplicate-ids");
		expect(config?.state).toBe("unverifiable");
		expect(config?.reason).toContain("dup");
		expect(e.state).toBe("unverifiable");
	});

	test("W: unknown kind -> unverifiable with an explicit reason", () => {
		const e = verify(
			[{ id: "x", kind: "telepathy" } as unknown as VerificationRequirement],
			[],
		);
		expect(stateOf(e, "x")).toBe("unverifiable");
		expect(e.checks[0]!.reason).toContain("Unknown requirement kind");
	});

	test("W2: malformed requirement does not throw", () => {
		const broken = { id: "broken" } as unknown as VerificationRequirement;
		expect(() => verify([broken], [])).not.toThrow();
		const e = verify([broken], []);
		expect(stateOf(e, "broken")).toBe("unverifiable");
	});
});

describe("Work-type defaults", () => {
	test("read-only work types get an implicit no-changes invariant", () => {
		for (const workType of ["investigate", "review", "verify"]) {
			const { requirements, notes } = deriveRequirements({ workType });
			expect(requirements.map((r) => r.kind)).toContain("no-changes");
			expect(notes.join(" ")).toContain("implicit no-changes");
		}
	});

	test("write work types get no default invariant", () => {
		for (const workType of ["implement", "refactor", "test"]) {
			const { requirements } = deriveRequirements({ workType });
			expect(requirements).toEqual([]);
		}
	});

	test("an explicit workspace check suppresses the read-only default", () => {
		const { requirements } = deriveRequirements({
			workType: "review",
			completionChecks: [
				{ id: "cf", kind: "changed-files", paths: ["notes.md"], mode: "exact" },
			],
		});
		expect(requirements.map((r) => r.kind)).toEqual(["changed-files"]);
	});

	test("implement with no changes is NOT a failure", () => {
		// §11: a legitimate implement/refactor/test task may change nothing.
		const { requirements } = deriveRequirements({ workType: "implement" });
		const e = verify(requirements, []);
		expect(e.state).toBe("unverifiable");
		expect(e.state).not.toBe("unsatisfied");
	});
});

describe("Determinism", () => {
	test("identical inputs produce identical evidence", () => {
		const reqs: VerificationRequirement[] = [
			{ id: "cf", kind: "changed-files", paths: ["a.ts"], mode: "exact" },
			{ id: "cmd", kind: "command", argv: ["npm", "test"] },
		];
		const a = JSON.stringify(verify(reqs, ["a.ts"]));
		const b = JSON.stringify(verify(reqs, ["a.ts"]));
		expect(a).toBe(b);
	});
});
