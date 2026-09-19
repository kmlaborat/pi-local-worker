import { describe, expect, test } from "vitest";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";

import { WorkerHarness, type WorkerSession } from "../src/worker-harness.ts";
import type { TaskSpec } from "../src/task-spec.ts";
import { FakeWorkerSession } from "./helpers/fake-session.ts";
import { createFakeGit, type FakeFile } from "./helpers/fake-git.ts";
import { VirtualWatchdogScheduler } from "./helpers/virtual-clock.ts";

/**
 * Harness-level evidence integration.
 *
 * The unit tests prove the comparison logic. These prove the lifecycle claims:
 * baseline before prompt, final observation after the drain, evidence for every
 * terminal cause, and no leaked resources.
 */

const BASE: FakeFile[] = [
	{ path: "README.md", status: "  ", indexBlob: "a".repeat(40), content: "# hi\n" },
	{ path: "src/app.ts", status: "  ", indexBlob: "b".repeat(40), content: "export const a = 1;\n" },
];

function spec(overrides: Partial<TaskSpec> = {}): TaskSpec {
	return {
		taskId: "ev-1",
		goal: "Change the workspace.",
		scope: ["src/app.ts"],
		workType: "implement",
		completionCriteria: ["the file is changed"],
		...overrides,
	};
}

function asSession(fake: FakeWorkerSession): { session: WorkerSession } {
	return { session: fake as unknown as WorkerSession };
}

/** A gate the test releases by hand, so the Worker's timing is fully controlled. */
function gate(): { promise: Promise<void>; release: () => void } {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

const settle = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/**
 * A gate that performs a workspace mutation *during* the Worker's turn.
 *
 * The mutation is deferred to a macrotask on purpose: an immediately-invoked
 * async closure would run its synchronous body at session construction time,
 * i.e. BEFORE the harness captures the baseline, which would make the change
 * invisible instead of proving it was detected.
 */
function mutatingDuringTurn(action: () => void, text = "done"): Promise<void> {
	return (async () => {
		await new Promise((r) => setTimeout(r, 5));
		action();
	})();
}

describe("Baseline ordering", () => {
	test("baseline is captured before the prompt is issued, final observation after", async () => {
		const git = createFakeGit({ files: BASE });
		try {
			const statusCallsAtPromptCount: number[] = [];
			let fake: FakeWorkerSession | undefined;
			const harness = new WorkerHarness({
				cwd: git.dir,
				gitRunner: {
					run(args, cwd) {
						if (args.join(" ").startsWith("status")) {
							statusCallsAtPromptCount.push(fake?.promptedTexts.length ?? 0);
						}
						return git.runner.run(args, cwd);
					},
				},
				createSession: async (_o: CreateAgentSessionOptions) => {
					fake = new FakeWorkerSession({ text: "done" });
					return asSession(fake);
				},
			});

			await harness.run(spec());

			// First status call: zero prompts issued => this was the baseline.
			expect(statusCallsAtPromptCount[0]).toBe(0);
			// A later status call with one prompt issued => the final observation.
			expect(statusCallsAtPromptCount.some((n) => n === 1)).toBe(true);
		} finally {
			git.cleanup();
		}
	});
});

describe("N — read-only Worker against a dirty workspace", () => {
	test("dirty baseline + no Worker change -> empty Worker change set", async () => {
		const dirty: FakeFile[] = [
			...BASE,
			{ path: "user-existing.ts", status: " M", indexBlob: "c".repeat(40), content: "user work\n" },
			{ path: "user-notes.md", status: "??", content: "scratch\n" },
		];
		const git = createFakeGit({ files: dirty });
		try {
			const harness = new WorkerHarness({
				cwd: git.dir,
				gitRunner: git.runner,
				createSession: async () => asSession(new FakeWorkerSession({ text: "reviewed, no edits" })),
			});

			const result = await harness.run(
				spec({ workType: "review", goal: "Review only.", scope: [] }),
			);
			expect(result.status).toBe("completed");
			expect(result.workspaceEvidence?.verificationStatus).toBe("available");
			// The dirty tree is NOT attributed to the Worker.
			expect(result.workspaceEvidence?.changedFiles).toEqual([]);
			// ...but it is recorded, not hidden.
			expect(result.workspaceEvidence?.baseline?.preExistingDirtyPaths).toEqual([
				"user-existing.ts",
			]);
			expect(result.workspaceEvidence?.baseline?.preExistingUntrackedPaths).toEqual([
				"user-notes.md",
			]);
		} finally {
			git.cleanup();
		}
	});
});

describe("O — implementation Worker", () => {
	test("Worker modification appears in evidence", async () => {
		const git = createFakeGit({ files: BASE });
		try {
			const harness = new WorkerHarness({
				cwd: git.dir,
				gitRunner: git.runner,
				createSession: async () =>
					asSession(
						new FakeWorkerSession({
							text: "changed it",
							// The Worker edits the workspace during its turn.
							gate: mutatingDuringTurn(() =>
								git.setFiles([
									BASE[0]!,
									{
										path: "src/app.ts",
										status: " M",
										indexBlob: "b".repeat(40),
										content: "changed by worker\n",
										// The fake's `diff --numstat` is driven by these
										// declared fields, mirroring real git output.
										added: 1,
										deleted: 1,
									},
								]),
							),
						}),
					),
			});

			const result = await harness.run(spec());
			expect(result.status).toBe("completed");
			const evidence = result.workspaceEvidence!;
			expect(evidence.verificationStatus).toBe("available");
			expect(evidence.changedFiles.map((f) => `${f.status} ${f.path}`)).toEqual([
				"M src/app.ts",
			]);
			expect(evidence.workerDiffStat.map((e) => e.path)).toEqual(["src/app.ts"]);
		} finally {
			git.cleanup();
		}
	});

	test("Worker-created untracked file appears in evidence", async () => {
		const git = createFakeGit({ files: BASE });
		try {
			const harness = new WorkerHarness({
				cwd: git.dir,
				gitRunner: git.runner,
				createSession: async () =>
					asSession(
						new FakeWorkerSession({
							text: "generated it",
							gate: mutatingDuringTurn(() =>
								git.setFiles([
									...BASE,
									{ path: "generated.txt", status: "??", content: "produced\n" },
								]),
							),
						}),
					),
			});

			const result = await harness.run(spec());
			const evidence = result.workspaceEvidence!;
			expect(evidence.changedFiles.map((f) => f.path)).toEqual(["generated.txt"]);
			expect(evidence.changedFiles[0]!.status).toBe("A");
			expect(evidence.changedFiles[0]!.untrackedNow).toBe(true);
		} finally {
			git.cleanup();
		}
	});
});

describe("P — TIMEOUT still carries evidence", () => {
	test("a timed-out run produces evidence and flags the undrained session", async () => {
		const git = createFakeGit({ files: BASE });
		const clock = new VirtualWatchdogScheduler();
		try {
			const harness = new WorkerHarness({
				cwd: git.dir,
				gitRunner: git.runner,
				timerScheduler: clock,
				workerTimeoutMs: 5_000,
				drainGraceMs: 1_000,
				// Never settles: the timeout must break the run.
				createSession: async () => asSession(new FakeWorkerSession({ gate: new Promise<void>(() => {}) })),
			});

			const running = harness.run(spec());
			await settle();
			clock.advance(6_000);
			const result = await running;

			expect(result.status).toBe("timeout");
			expect(result.workspaceEvidence).toBeDefined();
			expect(result.workspaceEvidence?.verificationStatus).toBe("available");
			// Nothing changed in this fixture, but the evidence was still produced.
			expect(result.workspaceEvidence?.changedFiles).toEqual([]);
			expect(result.workspaceEvidence?.limitations.join(" ")).toMatch(/did not drain/);
		} finally {
			git.cleanup();
		}
	});

	test("partial changes made before a timeout are evidenced", async () => {
		const git = createFakeGit({ files: BASE });
		const clock = new VirtualWatchdogScheduler();
		try {
			const harness = new WorkerHarness({
				cwd: git.dir,
				gitRunner: git.runner,
				timerScheduler: clock,
				workerTimeoutMs: 5_000,
				drainGraceMs: 1_000,
				// The Worker hangs forever; the test performs its workspace write
				// explicitly rather than racing a real timer against it.
				createSession: async () =>
					asSession(new FakeWorkerSession({ gate: new Promise<void>(() => {}) })),
			});

			const running = harness.run(spec());
			// Synchronize on the baseline capture instead of on wall-clock time.
			// A fixed sleep here would race session setup under load and could
			// interleave the write with the timeout observation.
			await git.waitForCall((args) => args.join(" ").startsWith("status"));
			git.setFiles([
				BASE[0]!,
				{
					path: "src/app.ts",
					status: " M",
					indexBlob: "b".repeat(40),
					content: "partial work\n",
				},
			]);
			clock.advance(6_000);
			const result = await running;

			expect(result.status).toBe("timeout");
			expect(result.workspaceEvidence?.changedFiles.map((f) => `${f.status} ${f.path}`)).toEqual([
				"M src/app.ts",
			]);
		} finally {
			git.cleanup();
		}
	});
});

describe("Q — ABORTED still carries evidence", () => {
	test("changes made before the abort are evidenced", async () => {
		const git = createFakeGit({ files: BASE });
		const g = gate();
		try {
			const harness = new WorkerHarness({
				cwd: git.dir,
				gitRunner: git.runner,
				drainGraceMs: 200,
				createSession: async () => asSession(new FakeWorkerSession({ gate: g.promise })),
			});

			const controller = new AbortController();
			const running = harness.run(spec(), controller.signal);
			// Synchronize on the baseline capture rather than on wall-clock time,
			// so the write cannot land before the baseline under load.
			await git.waitForCall((args) => args.join(" ").startsWith("status"));
			// Worker touches the workspace, then is aborted mid-turn.
			git.setFiles([
				BASE[0]!,
				{ path: "src/app.ts", status: " M", indexBlob: "b".repeat(40), content: "pre-abort work\n" },
			]);
			controller.abort();
			g.release();
			const result = await running;

			expect(result.status).toBe("aborted");
			expect(result.workspaceEvidence?.verificationStatus).toBe("available");
			expect(result.workspaceEvidence?.changedFiles.map((f) => `${f.status} ${f.path}`)).toEqual([
				"M src/app.ts",
			]);
		} finally {
			g.release();
			git.cleanup();
		}
	});
});

describe("R — Worker report vs workspace evidence", () => {
	test("both channels are preserved with no judgment when they disagree", async () => {
		const git = createFakeGit({ files: BASE });
		const reported = "I changed src/other.ts";
		try {
			const harness = new WorkerHarness({
				cwd: git.dir,
				gitRunner: git.runner,
				createSession: async () =>
					asSession(
						new FakeWorkerSession({
							text: reported,
							// Reality disagrees with the report.
							gate: mutatingDuringTurn(() =>
								git.setFiles([
									BASE[0]!,
									{
										path: "src/app.ts",
										status: " M",
										indexBlob: "b".repeat(40),
										content: "real change\n",
									},
								]),
							),
						}),
					),
			});

			const result = await harness.run(spec());

			// Both channels survive, unjudged.
			expect(result.finalResponse).toBe(reported);
			expect(result.workspaceEvidence?.changedFiles.map((f) => f.path)).toEqual(["src/app.ts"]);
			// No verdict vocabulary anywhere in the evidence.
			expect(JSON.stringify(result.workspaceEvidence)).not.toMatch(
				/lied|mismatch|incorrect|verdict|wrong/i,
			);
		} finally {
			git.cleanup();
		}
	});
});

describe("Baseline failure is not a Worker failure", () => {
	test("baseline capture failure -> evidence unavailable, Worker still completed", async () => {
		const git = createFakeGit({ files: BASE });
		try {
			let statusCalls = 0;
			const harness = new WorkerHarness({
				cwd: git.dir,
				gitRunner: {
					run(args, cwd) {
						if (args.join(" ").startsWith("status")) {
							statusCalls += 1;
							// Fail only the baseline (first) status call.
							if (statusCalls === 1) {
								return {
									ok: false,
									stdout: "",
									stderr: "fatal: baseline boom",
									code: 128,
								};
							}
						}
						return git.runner.run(args, cwd);
					},
				},
				createSession: async () => asSession(new FakeWorkerSession({ text: "worked fine" })),
			});

			const result = await harness.run(spec());
			// Worker succeeded; only the evidence failed.
			expect(result.status).toBe("completed");
			expect(result.finalResponse).toBe("worked fine");
			expect(result.error).toBeNull();
			expect(result.workspaceEvidence?.verificationStatus).toBe("unavailable");
			expect(result.workspaceEvidence?.errors.join(" ")).toMatch(/baseline capture failed/);
			expect(result.workspaceEvidence?.errors.join(" ")).toMatch(/baseline boom/);
			// No fabricated change list.
			expect(result.workspaceEvidence?.changedFiles).toEqual([]);
		} finally {
			git.cleanup();
		}
	});

	test("non-repository workspace -> evidence unavailable, Worker unaffected", async () => {
		// A runner that reports "not a work tree", so the test does not depend on
		// whether the machine's temp dir happens to sit inside a repository.
		const notARepo = {
			runner: {
				run: () => ({
					ok: false,
					stdout: "",
					stderr: "fatal: not a git repository (or any of the parent directories): .git",
					code: 128,
				}),
			},
		};
		const harness = new WorkerHarness({
			cwd: ".",
			gitRunner: notARepo.runner,
			createSession: async () => asSession(new FakeWorkerSession({ text: "no git here" })),
		});
		const result = await harness.run(spec());
		expect(result.status).toBe("completed");
		expect(result.finalResponse).toBe("no git here");
		expect(result.workspaceEvidence?.verificationStatus).toBe("unavailable");
		expect(result.workspaceEvidence?.errors.join(" ")).toMatch(/not a git work tree/);
		expect(result.workspaceEvidence?.changedFiles).toEqual([]);
	});
});

describe("Final observation failure", () => {
	test("baseline survives, final evidence reports failure", async () => {
		const git = createFakeGit({ files: BASE });
		try {
			let statusCalls = 0;
			const harness = new WorkerHarness({
				cwd: git.dir,
				gitRunner: {
					run(args, cwd) {
						if (args.join(" ").startsWith("status")) {
							statusCalls += 1;
							// Baseline succeeds; the final observation fails.
							if (statusCalls > 1) {
								return {
									ok: false,
									stdout: "",
									stderr: "fatal: cannot lock index",
									code: 128,
								};
							}
						}
						return git.runner.run(args, cwd);
					},
				},
				createSession: async () => asSession(new FakeWorkerSession({ text: "done" })),
			});

			const result = await harness.run(spec());
			expect(result.status).toBe("completed");
			expect(result.workspaceEvidence?.verificationStatus).toBe("unavailable");
			// §21: the baseline summary is retained.
			expect(result.workspaceEvidence?.baseline).toBeDefined();
			expect(result.workspaceEvidence?.errors.join(" ")).toMatch(/final observation failed/);
			expect(result.workspaceEvidence?.changedFiles).toEqual([]);
		} finally {
			git.cleanup();
		}
	});
});

describe("Evidence collected after the drain", () => {
	test("a late Worker write is visible because observation follows settlement", async () => {
		const git = createFakeGit({ files: BASE });
		const g = gate();
		try {
			const harness = new WorkerHarness({
				cwd: git.dir,
				gitRunner: git.runner,
				createSession: async () =>
					asSession(
						new FakeWorkerSession({
							text: "late",
							gate: (async () => {
								await g.promise;
								git.setFiles([
									BASE[0]!,
									{
										path: "src/app.ts",
										status: " M",
										indexBlob: "b".repeat(40),
										content: "late work\n",
									},
								]);
							})(),
						}),
					),
			});

			const running = harness.run(spec());
			await settle();
			g.release();
			const result = await running;

			expect(result.workspaceEvidence?.changedFiles.map((f) => f.path)).toEqual(["src/app.ts"]);
		} finally {
			g.release();
			git.cleanup();
		}
	});
});

describe("T — no leaked resources", () => {
	test("evidence collection adds no surviving timers and leaves the slot free", async () => {
		const git = createFakeGit({ files: BASE });
		const clock = new VirtualWatchdogScheduler();
		try {
			const harness = new WorkerHarness({
				cwd: git.dir,
				gitRunner: git.runner,
				timerScheduler: clock,
				createSession: async () => asSession(new FakeWorkerSession({ text: "x" })),
			});

			await harness.run(spec());
			expect(clock.liveTimerCount).toBe(0);
			expect(harness.activeWorker).toBeNull();

			// A second run is possible immediately: the slot was released cleanly.
			const second = await harness.run(spec({ taskId: "ev-2" }));
			expect(second.status).toBe("completed");
			expect(clock.liveTimerCount).toBe(0);
		} finally {
			git.cleanup();
		}
	});

	test("disabled evidence is reported as unavailable, never as an empty change set", async () => {
		const git = createFakeGit({ files: BASE });
		try {
			const harness = new WorkerHarness({
				cwd: git.dir,
				gitRunner: git.runner,
				disableWorkspaceEvidence: true,
				createSession: async () => asSession(new FakeWorkerSession({ text: "x" })),
			});
			const result = await harness.run(spec());
			expect(result.workspaceEvidence?.verificationStatus).toBe("unavailable");
			expect(result.workspaceEvidence?.errors.join(" ")).toMatch(/disabled/);
		} finally {
			git.cleanup();
		}
	});
});

describe("Determinism", () => {
	test("same baseline and final state produce identical evidence across runs", async () => {
		const files: FakeFile[] = [
			BASE[0]!,
			{ path: "src/app.ts", status: " M", indexBlob: "b".repeat(40), content: "same\n" },
		];
		const results: string[] = [];
		for (let i = 0; i < 2; i += 1) {
			const git = createFakeGit({ files: BASE });
			try {
				const harness = new WorkerHarness({
					cwd: git.dir,
					gitRunner: git.runner,
					createSession: async () =>
						asSession(
							new FakeWorkerSession({
								text: "x",
								gate: mutatingDuringTurn(() => git.setFiles(files)),
							}),
						),
				});
				const r = await harness.run(spec({ taskId: `det-${i}` }));
				results.push(JSON.stringify(r.workspaceEvidence?.changedFiles ?? []));
			} finally {
				git.cleanup();
			}
		}
		expect(results[0]).toBe(results[1]);
		expect(results[0]).toContain("src/app.ts");
	});
});
