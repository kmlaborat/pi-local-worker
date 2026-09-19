import { describe, expect, test } from "vitest";

import { DEFAULT_GATE_POLICY, type GatePolicy } from "../src/gate.ts";
import {
	WorkerHarness,
	type WorkerHarnessConfig,
	type WorkerSession,
} from "../src/worker-harness.ts";
import type { TaskSpec } from "../src/task-spec.ts";
import { FakeWorkerSession } from "./helpers/fake-session.ts";
import { createFakeCommandRunner } from "./helpers/fake-command.ts";
import { createFakeGit, type FakeFile } from "./helpers/fake-git.ts";
import { VirtualWatchdogScheduler } from "./helpers/virtual-clock.ts";

/**
 * Gate integration through the harness.
 *
 * The unit tests prove the decision function. These prove the wiring: the Gate
 * runs at the right point in the lifecycle, never rewrites execution status,
 * honours an injected policy, and performs no I/O of its own.
 */

const BASE: FakeFile[] = [
	{ path: "README.md", status: "  ", indexBlob: "a".repeat(40), content: "# hi\n" },
	{ path: "src/app.ts", status: "  ", indexBlob: "b".repeat(40), content: "export const a = 1;\n" },
];

function spec(overrides: Partial<TaskSpec> = {}): TaskSpec {
	return {
		taskId: "g-1",
		goal: "Work on src/app.ts.",
		scope: ["src/app.ts"],
		workType: "implement",
		completionCriteria: ["src/app.ts is updated"],
		...overrides,
	} as TaskSpec;
}

function asSession(fake: FakeWorkerSession): { session: WorkerSession } {
	return { session: fake as unknown as WorkerSession };
}

const EXACT_APP = [
	{ id: "cf", kind: "changed-files", paths: ["src/app.ts"], mode: "exact" },
] as TaskSpec["completionChecks"];

/** Run a Worker that changes exactly src/app.ts, with the baseline synced first. */
async function runChangingApp(
	extra: Partial<WorkerHarnessConfig> = {},
	specOverrides: Partial<TaskSpec> = {},
) {
	const git = createFakeGit({ files: BASE });
	let release!: () => void;
	try {
		const harness = new WorkerHarness({
			cwd: git.dir,
			gitRunner: git.runner,
			...extra,
			createSession: async () =>
				asSession(
					new FakeWorkerSession({
						text: "updated src/app.ts",
						gate: new Promise<void>((r) => {
							release = r;
						}),
					}),
				),
		});
		const running = harness.run(spec(specOverrides));
		await git.waitForCall((a) => a.join(" ").startsWith("status"));
		git.setFiles([
			BASE[0]!,
			{ path: "src/app.ts", status: " M", indexBlob: "b".repeat(40), content: "export const a = 2;\n" },
		]);
		release();
		return await running;
	} finally {
		release?.();
		git.cleanup();
	}
}

describe("Decision wiring", () => {
	test("completed + satisfied verification -> accept", async () => {
		const r = await runChangingApp({}, { completionChecks: EXACT_APP });
		expect(r.status).toBe("completed");
		expect(r.verification?.state).toBe("satisfied");
		expect(r.gate?.decision).toBe("accept");
		expect(r.gate?.reasonCodes).toEqual(["accepted"]);
	});

	test("completed + unsatisfied verification -> reject, status stays completed", async () => {
		const r = await runChangingApp(
			{},
			{
				completionChecks: [
					{ id: "cf", kind: "changed-files", paths: ["src/other.ts"], mode: "exact" },
				] as TaskSpec["completionChecks"],
			},
		);
		// The Worker terminated normally. The policy simply declined to accept.
		expect(r.status).toBe("completed");
		expect(r.error).toBeNull();
		expect(r.verification?.state).toBe("unsatisfied");
		expect(r.gate?.decision).toBe("reject");
		expect(r.gate?.reasonCodes).toEqual(["verification-unsatisfied"]);
	});

	test("completed + no machine-checkable requirement -> inspect", async () => {
		const r = await runChangingApp({}, { completionChecks: undefined });
		expect(r.status).toBe("completed");
		expect(r.verification?.state).toBe("unverifiable");
		expect(r.gate?.decision).toBe("inspect");
		expect(r.gate?.reasonCodes).toEqual(["verification-unverifiable"]);
	});

	test("timeout + satisfied workspace verification -> reject on execution", async () => {
		const git = createFakeGit({ files: BASE });
		const clock = new VirtualWatchdogScheduler();
		try {
			const harness = new WorkerHarness({
				cwd: git.dir,
				gitRunner: git.runner,
				timerScheduler: clock,
				workerTimeoutMs: 5_000,
				drainGraceMs: 500,
				createSession: async () =>
					asSession(new FakeWorkerSession({ gate: new Promise<void>(() => {}) })),
			});
			const running = harness.run(spec({ completionChecks: EXACT_APP }));
			await git.waitForCall((a) => a.join(" ").startsWith("status"));
			git.setFiles([
				BASE[0]!,
				{ path: "src/app.ts", status: " M", indexBlob: "b".repeat(40), content: "partial\n" },
			]);
			clock.advance(6_000);
			const r = await running;

			// Both facts preserved: the workspace condition held, the run did not.
			expect(r.status).toBe("timeout");
			expect(r.verification?.state).toBe("satisfied");
			expect(r.gate?.decision).toBe("reject");
			expect(r.gate?.reasonCodes).toEqual(["execution-not-completed"]);
			expect(
				r.gate?.checks.find((c) => c.id === "gate:verification-state")?.decision,
			).toBe("satisfied");
		} finally {
			git.cleanup();
		}
	});

	test("review with a dirty repo -> accept via the verifier's implicit no-changes", async () => {
		const dirty: FakeFile[] = [
			...BASE,
			{ path: "user-existing.ts", status: " M", indexBlob: "c".repeat(40), content: "user\n" },
			{ path: "user-notes.md", status: "??", content: "scratch\n" },
		];
		const git = createFakeGit({ files: dirty });
		try {
			const harness = new WorkerHarness({
				cwd: git.dir,
				gitRunner: git.runner,
				createSession: async () => asSession(new FakeWorkerSession({ text: "reviewed" })),
			});
			const r = await harness.run(
				spec({ workType: "review", goal: "Review only.", scope: [] }),
			);
			// The Gate consumed the verifier's generated no-changes check.
			expect(r.verification?.checks.map((c) => c.kind)).toContain("no-changes");
			expect(r.gate?.decision).toBe("accept");
		} finally {
			git.cleanup();
		}
	});
});

describe("Policy injection through the harness", () => {
	test("an injected policy changes the outcome for identical evidence", async () => {
		const strict = await runChangingApp(
			{},
			{
				completionChecks: [
					{ id: "cf", kind: "changed-files", paths: ["nope.ts"], mode: "exact" },
				] as TaskSpec["completionChecks"],
			},
		);
		const relaxed = await runChangingApp(
			{ gatePolicy: { requireExecutionCompleted: true, requireVerificationSatisfied: false } },
			{
				completionChecks: [
					{ id: "cf", kind: "changed-files", paths: ["nope.ts"], mode: "exact" },
				] as TaskSpec["completionChecks"],
			},
		);
		expect(strict.verification?.state).toBe("unsatisfied");
		expect(strict.gate?.decision).toBe("reject");
		expect(relaxed.verification?.state).toBe("unsatisfied");
		expect(relaxed.gate?.decision).toBe("accept");
		// The evidence recorded which policy was actually applied.
		expect(relaxed.gate?.policy).toEqual({
			requireExecutionCompleted: true,
			requireVerificationSatisfied: false,
		});
	});

	test("the default policy is recorded when none is injected", async () => {
		const r = await runChangingApp({}, { completionChecks: EXACT_APP });
		expect(r.gate?.policy).toEqual(DEFAULT_GATE_POLICY);
	});
});

describe("Gate is observational", () => {
	test("the Gate issues no git commands and no validation commands", async () => {
		const git = createFakeGit({ files: BASE });
		const cmds = createFakeCommandRunner([]);
		let gitCallsAtGate = -1;
		let cmdCallsAtGate = -1;
		let release!: () => void;
		try {
			const harness = new WorkerHarness({
				cwd: git.dir,
				// Wrap the git runner to snapshot call counts at gate evaluation time.
				gitRunner: {
					run: (args, cwd) => {
						const result = git.runner.run(args, cwd);
						return result;
					},
				},
				commandRunner: {
					run: (argv, options) => {
						// The Gate runs after all commands; record the count it sees.
						const r = cmds.runner.run(argv, options);
						cmdCallsAtGate = cmds.calls.length;
						gitCallsAtGate = git.calls.length;
						return r;
					},
				},
				createSession: async () =>
					asSession(
						new FakeWorkerSession({
							text: "done",
							gate: new Promise<void>((r) => {
								release = r;
							}),
						}),
					),
			});
			const running = harness.run(
				spec({ completionChecks: [{ id: "v", kind: "command", argv: ["npm", "test"] }] }),
			);
			await git.waitForCall((a) => a.join(" ").startsWith("status"));
			release();
			const r = await running;

			expect(r.gate).toBeDefined();
			// No further git or command activity is attributable to the Gate:
			// the gate consumed only in-memory facts.
			expect(cmdCallsAtGate).toBe(1);
			expect(gitCallsAtGate).toBe(git.calls.length);
			// No mutating git subcommand was ever issued during the whole run.
			const mutating = git.calls.filter((c) =>
				["checkout", "reset", "stash", "clean", "commit", "apply", "restore", "revert"].includes(
					c[0] ?? "",
				),
			);
			expect(mutating).toEqual([]);
		} finally {
			release?.();
			git.cleanup();
		}
	});

	test("the Gate never mutates the workspace", async () => {
		const git = createFakeGit({ files: BASE });
		try {
			const before = git.calls.length;
			const harness = new WorkerHarness({
				cwd: git.dir,
				gitRunner: git.runner,
				createSession: async () => asSession(new FakeWorkerSession({ text: "done" })),
			});
			await harness.run(spec({ completionChecks: EXACT_APP }));
			// Only the two expected status reads (baseline + final) plus ls-files/rev-parse.
			// Nothing after the final observation.
			const after = git.calls.filter((c) => c.join(" ").startsWith("status")).length;
			expect(after).toBe(2);
			expect(before).toBeLessThan(git.calls.length);
		} finally {
			git.cleanup();
		}
	});
});

describe("Gate present on every terminal path", () => {
	test("aborted-before-start still carries a Gate decision", async () => {
		const git = createFakeGit({ files: BASE });
		try {
			const harness = new WorkerHarness({
				cwd: git.dir,
				gitRunner: git.runner,
				createSession: async () => asSession(new FakeWorkerSession({ text: "never runs" })),
			});
			const controller = new AbortController();
			controller.abort();
			const r = await harness.run(spec({ completionChecks: EXACT_APP }), controller.signal);
			expect(r.status).toBe("aborted");
			// No baseline existed, so verification is unverifiable; execution
			// failed anyway, so the policy rejects.
			expect(r.gate?.decision).toBe("reject");
			expect(r.gate?.reasonCodes).toContain("execution-not-completed");
		} finally {
			git.cleanup();
		}
	});

	test("session-creation failure still carries a Gate decision", async () => {
		const git = createFakeGit({ files: BASE });
		try {
			const harness = new WorkerHarness({
				cwd: git.dir,
				gitRunner: git.runner,
				createSession: async () => {
					throw new Error("cannot create session");
				},
			});
			const r = await harness.run(spec({ completionChecks: EXACT_APP }));
			expect(r.status).toBe("error");
			expect(r.gate?.decision).toBe("reject");
		} finally {
			git.cleanup();
		}
	});
});

describe("Result composition", () => {
	test("the result stays compositional with no aggregate judgment field", async () => {
		const r = await runChangingApp({}, { completionChecks: EXACT_APP });
		const keys = Object.keys(r).sort();
		expect(keys).toEqual([
			"boundary",
			"error",
			"finalResponse",
			"finalState",
			"gate",
			"orchestration",
			"status",
			"steering",
			"taskId",
			"timeout",
			"verification",
			"watchdog",
			"workspaceEvidence",
		]);
		// No top-level success/quality/score field.
		expect(keys).not.toContain("success");
		expect(keys).not.toContain("quality");
		expect(keys).not.toContain("score");
	});
});
