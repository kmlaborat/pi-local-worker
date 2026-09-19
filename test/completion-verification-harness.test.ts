import { describe, expect, test } from "vitest";

import { WorkerHarness, type WorkerSession } from "../src/worker-harness.ts";
import type { TaskSpec } from "../src/task-spec.ts";
import type { VerificationRequirement } from "../src/verification.ts";
import { FakeWorkerSession } from "./helpers/fake-session.ts";
import { createFakeCommandRunner } from "./helpers/fake-command.ts";
import { createFakeGit, type FakeFile } from "./helpers/fake-git.ts";
import { VirtualWatchdogScheduler } from "./helpers/virtual-clock.ts";

/**
 * Harness-level completion-verification integration.
 *
 * Proves the ordering and independence claims: verification runs after Worker
 * teardown, for every terminal cause, from evidence rather than Worker prose, and
 * without touching the repository or the execution status.
 */

const BASE: FakeFile[] = [
	{ path: "README.md", status: "  ", indexBlob: "a".repeat(40), content: "# hi\n" },
	{ path: "src/app.ts", status: "  ", indexBlob: "b".repeat(40), content: "export const a = 1;\n" },
];

function spec(overrides: Partial<TaskSpec> = {}): TaskSpec {
	return {
		taskId: "v-1",
		goal: "Change src/app.ts.",
		scope: ["src/app.ts"],
		workType: "implement",
		completionCriteria: ["src/app.ts is updated"],
		...overrides,
	};
}

function asSession(fake: FakeWorkerSession): { session: WorkerSession } {
	return { session: fake as unknown as WorkerSession };
}

const stateOf = (result: { verification?: { checks: readonly { id: string; state: string }[] } }, id: string) =>
	result.verification?.checks.find((c) => c.id === id)?.state;

describe("Structured requirement satisfied by real Worker work", () => {
	test("changed-files exact verifies against the observed change set", async () => {
		const git = createFakeGit({ files: BASE });
		const cmds = createFakeCommandRunner([{ argv: ["npm", "test"], result: { exitCode: 0 } }]);
		let release!: () => void;
		try {
			const harness = new WorkerHarness({
				cwd: git.dir,
				gitRunner: git.runner,
				commandRunner: cmds.runner,
				createSession: async () =>
					asSession(
						new FakeWorkerSession({
							text: "I updated src/app.ts",
							gate: new Promise<void>((r) => {
								release = r;
							}),
						}),
					),
			});

			const running = harness.run(
				spec({
					completionChecks: [
						{ id: "cf", kind: "changed-files", paths: ["src/app.ts"], mode: "exact" },
					],
				}),
			);
			// Wait for the baseline, then have the Worker change exactly that file.
			await git.waitForCall((a) => a.join(" ").startsWith("status"));
			git.setFiles([
				BASE[0]!,
				{
					path: "src/app.ts",
					status: " M",
					indexBlob: "b".repeat(40),
					content: "export const a = 2;\n",
				},
			]);
			release();
			const result = await running;

			expect(result.status).toBe("completed");
			expect(stateOf(result, "cf")).toBe("satisfied");
			expect(result.verification?.state).toBe("satisfied");
		} finally {
			release?.();
			git.cleanup();
		}
	});
});

describe("Q — TIMEOUT with partial work", () => {
	test("workspace verification still runs after a timeout", async () => {
		const git = createFakeGit({ files: BASE });
		const clock = new VirtualWatchdogScheduler();
		try {
			const harness = new WorkerHarness({
				cwd: git.dir,
				gitRunner: git.runner,
				timerScheduler: clock,
				workerTimeoutMs: 5_000,
				drainGraceMs: 500,
				// Never settles: the timeout must break the run.
				createSession: async () =>
					asSession(new FakeWorkerSession({ gate: new Promise<void>(() => {}) })),
			});

			const running = harness.run(
				spec({
					completionChecks: [
						{ id: "cf", kind: "changed-files", paths: ["src/app.ts"], mode: "exact" },
					],
				}),
			);
			await git.waitForCall((a) => a.join(" ").startsWith("status"));
			// Partial work lands, then the Worker hangs until the deadline.
			git.setFiles([
				BASE[0]!,
				{
					path: "src/app.ts",
					status: " M",
					indexBlob: "b".repeat(40),
					content: "partial\n",
				},
			]);
			clock.advance(6_000);
			const result = await running;

			// Execution failed, but the workspace condition was still observed.
			expect(result.status).toBe("timeout");
			expect(stateOf(result, "cf")).toBe("satisfied");
			expect(result.verification?.state).toBe("satisfied");
		} finally {
			git.cleanup();
		}
	});

	test("timeout with an unmet requirement reports unsatisfied without changing status", async () => {
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
			const running = harness.run(
				spec({
					completionChecks: [
						{ id: "cf", kind: "changed-files", paths: ["src/other.ts"], mode: "exact" },
					],
				}),
			);
			await git.waitForCall((a) => a.join(" ").startsWith("status"));
			clock.advance(6_000);
			const result = await running;

			expect(result.status).toBe("timeout");
			expect(stateOf(result, "cf")).toBe("unsatisfied");
		} finally {
			git.cleanup();
		}
	});
});

describe("R — ABORTED with partial work", () => {
	test("workspace verification still runs after an abort", async () => {
		const git = createFakeGit({ files: BASE });
		let release!: () => void;
		try {
			const harness = new WorkerHarness({
				cwd: git.dir,
				gitRunner: git.runner,
				drainGraceMs: 200,
				createSession: async () =>
					asSession(
						new FakeWorkerSession({
							gate: new Promise<void>((r) => {
								release = r;
							}),
						}),
					),
			});

			const controller = new AbortController();
			const running = harness.run(
				spec({
					completionChecks: [
						{ id: "cf", kind: "changed-files", paths: ["src/app.ts"], mode: "exact" },
					],
				}),
				controller.signal,
			);
			await git.waitForCall((a) => a.join(" ").startsWith("status"));
			git.setFiles([
				BASE[0]!,
				{ path: "src/app.ts", status: " M", indexBlob: "b".repeat(40), content: "pre-abort\n" },
			]);
			controller.abort();
			release();
			const result = await running;

			expect(result.status).toBe("aborted");
			expect(stateOf(result, "cf")).toBe("satisfied");
		} finally {
			release?.();
			git.cleanup();
		}
	});
});

describe("S — ERROR with partial work", () => {
	test("workspace verification still runs when the Worker errors", async () => {
		const git = createFakeGit({ files: BASE });
		try {
			const harness = new WorkerHarness({
				cwd: git.dir,
				gitRunner: git.runner,
				createSession: async () =>
					asSession(
						new FakeWorkerSession({
							// The turn fails, but only after the workspace was touched.
							gate: (async () => {
								await new Promise((r) => setTimeout(r, 5));
								git.setFiles([
									BASE[0]!,
									{
										path: "src/app.ts",
										status: " M",
										indexBlob: "b".repeat(40),
										content: "changed then failed\n",
									},
								]);
							})(),
							promptError: new Error("model exploded"),
						}),
					),
			});

			const result = await harness.run(
				spec({
					completionChecks: [
						{ id: "cf", kind: "changed-files", paths: ["src/app.ts"], mode: "exact" },
					],
				}),
			);

			expect(result.status).toBe("error");
			expect(stateOf(result, "cf")).toBe("satisfied");
		} finally {
			git.cleanup();
		}
	});
});

describe("T — verification uses evidence, not Worker prose", () => {
	test("a confident false report does not satisfy a changed-files check", async () => {
		const git = createFakeGit({ files: BASE });
		try {
			const harness = new WorkerHarness({
				cwd: git.dir,
				gitRunner: git.runner,
				createSession: async () =>
					asSession(
						new FakeWorkerSession({
							text: "I changed src/app.ts and added full test coverage.",
						}),
					),
			});
			// The Worker claims the change; the workspace never changed.
			const result = await harness.run(
				spec({
					completionChecks: [
						{ id: "cf", kind: "changed-files", paths: ["src/app.ts"], mode: "exact" },
					],
				}),
			);

			expect(result.finalResponse).toContain("I changed src/app.ts");
			expect(stateOf(result, "cf")).toBe("unsatisfied");
		} finally {
			git.cleanup();
		}
	});

	test("a modest denial does not unsatisfy a check the evidence satisfies", async () => {
		const git = createFakeGit({ files: BASE });
		let release!: () => void;
		try {
			const harness = new WorkerHarness({
				cwd: git.dir,
				gitRunner: git.runner,
				createSession: async () =>
					asSession(
						new FakeWorkerSession({
							text: "I could not make any progress.",
							gate: new Promise<void>((r) => {
								release = r;
							}),
						}),
					),
			});
			const running = harness.run(
				spec({
					completionChecks: [
						{ id: "cf", kind: "changed-files", paths: ["src/app.ts"], mode: "exact" },
					],
				}),
			);
			await git.waitForCall((a) => a.join(" ").startsWith("status"));
			git.setFiles([
				BASE[0]!,
				{ path: "src/app.ts", status: " M", indexBlob: "b".repeat(40), content: "actually done\n" },
			]);
			release();
			const result = await running;

			expect(result.finalResponse).toContain("could not make any progress");
			expect(stateOf(result, "cf")).toBe("satisfied");
		} finally {
			release?.();
			git.cleanup();
		}
	});
});

describe("Ordering and independence", () => {
	test("verification runs after the session is disposed", async () => {
		const git = createFakeGit({ files: BASE });
		// The fake session is created inside createSession; record its disposeCount
		// at the moment the validation command runs, which is inside verification.
		const observed: number[] = [];
		let session: FakeWorkerSession | undefined;
		try {
			const harness = new WorkerHarness({
				cwd: git.dir,
				gitRunner: git.runner,
				commandRunner: {
					run: () => {
						observed.push(session?.disposeCount ?? -1);
						return {
							started: true,
							exitCode: 0,
							timedOut: false,
							stdout: "",
							stderr: "",
						};
					},
				},
				createSession: async () => {
					session = new FakeWorkerSession({ text: "done" });
					return asSession(session);
				},
			});

			await harness.run(
				spec({ completionChecks: [{ id: "v", kind: "command", argv: ["npm", "test"] }] }),
			);
			// The command ran exactly once, after dispose.
			expect(observed).toEqual([1]);
		} finally {
			git.cleanup();
		}
	});

	test("verification never changes the execution status", async () => {
		const git = createFakeGit({ files: BASE });
		try {
			const harness = new WorkerHarness({
				cwd: git.dir,
				gitRunner: git.runner,
				commandRunner: createFakeCommandRunner([
					{ argv: ["npm", "test"], result: { exitCode: 7 } },
				]).runner,
				createSession: async () => asSession(new FakeWorkerSession({ text: "done" })),
			});
			const result = await harness.run(
				spec({ completionChecks: [{ id: "v", kind: "command", argv: ["npm", "test"] }] }),
			);
			// Validation failed; execution still reported completed.
			expect(result.status).toBe("completed");
			expect(result.error).toBeNull();
			expect(stateOf(result, "v")).toBe("unsatisfied");
		} finally {
			git.cleanup();
		}
	});

	test("verification performs no repository mutation", async () => {
		const git = createFakeGit({ files: BASE });
		try {
			const before = git.calls.filter((c) =>
				["checkout", "reset", "stash", "clean", "commit", "apply", "restore"].includes(
					c[0] ?? "",
				),
			);
			const harness = new WorkerHarness({
				cwd: git.dir,
				gitRunner: git.runner,
				createSession: async () => asSession(new FakeWorkerSession({ text: "done" })),
			});
			await harness.run(
				spec({
					completionChecks: [
						{ id: "cf", kind: "changed-files", paths: [], mode: "exact" },
						{ id: "fb", kind: "forbidden-files", paths: ["x.ts"] },
					],
				}),
			);
			const after = git.calls.filter((c) =>
				["checkout", "reset", "stash", "clean", "commit", "apply", "restore"].includes(
					c[0] ?? "",
				),
			);
			expect(after).toEqual(before);
			expect(after).toEqual([]);
		} finally {
			git.cleanup();
		}
	});

	test("verification is present on the pre-session abort path too", async () => {
		const git = createFakeGit({ files: BASE });
		try {
			const harness = new WorkerHarness({
				cwd: git.dir,
				gitRunner: git.runner,
				createSession: async () => asSession(new FakeWorkerSession({ text: "never runs" })),
			});
			const controller = new AbortController();
			controller.abort();
			const result = await harness.run(
				spec({ completionChecks: [{ id: "nc", kind: "no-changes" }] }),
				controller.signal,
			);
			expect(result.status).toBe("aborted");
			// No baseline existed, so the workspace check is unverifiable, not failed.
			expect(stateOf(result, "nc")).toBe("unverifiable");
		} finally {
			git.cleanup();
		}
	});

	test("the N=1 slot is held while verification runs", async () => {
		const git = createFakeGit({ files: BASE });
		// Sampled from inside the validation command, which executes during
		// verification. A synchronous runner blocks the thread, so the slot cannot
		// be observed from outside — sampling at the point of execution is the
		// direct way to prove the invariant.
		const busyDuringVerification: boolean[] = [];
		try {
			const harness = new WorkerHarness({
				cwd: git.dir,
				gitRunner: git.runner,
				commandRunner: {
					run: () => {
						busyDuringVerification.push(harness.isBusy);
						return {
							started: true,
							exitCode: 0,
							timedOut: false,
							stdout: "",
							stderr: "",
						};
					},
				},
				createSession: async () => asSession(new FakeWorkerSession({ text: "done" })),
			});

			await harness.run(
				spec({ completionChecks: [{ id: "v", kind: "command", argv: ["npm", "test"] }] }),
			);
			expect(busyDuringVerification).toEqual([true]);
			// Released only after verification completed.
			expect(harness.isBusy).toBe(false);
		} finally {
			git.cleanup();
		}
	});

	test("a real validation command is bounded by its own timeout", async () => {
		const git = createFakeGit({ files: BASE });
		try {
			const harness = new WorkerHarness({
				cwd: git.dir,
				gitRunner: git.runner,
				// Independent of workerTimeoutMs, and shorter than the sleep below.
				verificationCommandTimeoutMs: 300,
				createSession: async () => asSession(new FakeWorkerSession({ text: "done" })),
			});

			const started = Date.now();
			const result = await harness.run(
				spec({
					completionChecks: [
						{
							id: "v",
							kind: "command",
							argv: [process.execPath, "-e", "setTimeout(() => {}, 10_000)"],
						},
					],
				}),
			);
			const elapsed = Date.now() - started;

			// Bounded: returned in ~300ms, not 10s.
			expect(elapsed).toBeLessThan(5_000);
			expect(result.verification?.validation[0]?.timedOut).toBe(true);
			expect(stateOf(result, "v")).toBe("unverifiable");
			// Execution status untouched by the validation timeout.
			expect(result.status).toBe("completed");
		} finally {
			git.cleanup();
		}
	});
});

describe("Read-only work type through the harness", () => {
	test("review with a dirty baseline verifies no-changes as satisfied", async () => {
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
			const result = await harness.run(
				spec({ workType: "review", goal: "Review only.", scope: [] }),
			);
			expect(result.status).toBe("completed");
			expect(stateOf(result, "worktype-default:no-changes")).toBe("satisfied");
			expect(result.verification?.state).toBe("satisfied");
		} finally {
			git.cleanup();
		}
	});
});

describe("Requirement typing", () => {
	test("a requirement list survives JSON serialization", async () => {
		const reqs: VerificationRequirement[] = [
			{ id: "cf", kind: "changed-files", paths: ["a.ts"], mode: "exact" },
			{ id: "v", kind: "command", argv: ["npm", "test"] },
		];
		const round = JSON.parse(JSON.stringify(reqs)) as VerificationRequirement[];
		expect(round).toEqual(reqs);
	});
});
