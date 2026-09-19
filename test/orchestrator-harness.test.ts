import { describe, expect, test } from "vitest";

import {
	WorkerHarness,
	type WorkerHarnessConfig,
	type WorkerSession,
} from "../src/worker-harness.ts";
import type { TaskSpec } from "../src/task-spec.ts";
import { FakeWorkerSession } from "./helpers/fake-session.ts";
import { createFakeGit, type FakeFile } from "./helpers/fake-git.ts";
import { VirtualWatchdogScheduler } from "./helpers/virtual-clock.ts";

/**
 * Step 10 — the Orchestrator inside the harness.
 *
 * The harness keeps ownership of the Worker lifecycle; the Orchestrator only
 * reads the finished result. These tests pin the ordering, the N=1 slot
 * behaviour across orchestration, and the absence of any retry.
 */

const BASE: FakeFile[] = [
	{ path: "README.md", status: "  ", indexBlob: "a".repeat(40), content: "# hi\n" },
	{ path: "src/app.ts", status: "  ", indexBlob: "b".repeat(40), content: "export const a = 1;\n" },
];

function spec(overrides: Partial<TaskSpec> = {}): TaskSpec {
	return {
		taskId: "o-1",
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

const WRONG_FILE = [
	{ id: "cf", kind: "changed-files", paths: ["src/other.ts"], mode: "exact" },
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
			{
				path: "src/app.ts",
				status: " M",
				indexBlob: "b".repeat(40),
				content: "export const a = 2;\n",
			},
		]);
		release();
		return await running;
	} finally {
		release?.();
		git.cleanup();
	}
}

describe("Every terminal path carries a decision", () => {
	test("accept -> return / RETURNED", async () => {
		const r = await runChangingApp({}, { completionChecks: EXACT_APP });
		expect(r.gate?.decision).toBe("accept");
		expect(r.orchestration?.action).toBe("return");
		expect(r.orchestration?.status).toBe("RETURNED");
		expect(r.orchestration?.reasonCode).toBe("gate-accepted");
	});

	test("reject -> return, and the Worker status is untouched", async () => {
		const r = await runChangingApp({}, { completionChecks: WRONG_FILE });
		expect(r.status).toBe("completed");
		expect(r.verification?.state).toBe("unsatisfied");
		expect(r.orchestration?.action).toBe("return");
		expect(r.orchestration?.reasonCode).toBe("gate-rejected");
	});

	test("inspect -> INSPECTION_REQUIRED, not an error", async () => {
		const r = await runChangingApp({}, { completionChecks: undefined });
		expect(r.verification?.state).toBe("unverifiable");
		expect(r.gate?.decision).toBe("inspect");
		expect(r.orchestration?.action).toBe("inspect");
		expect(r.orchestration?.status).toBe("INSPECTION_REQUIRED");
		expect(r.error).toBeNull();
	});

	test("timeout -> reject -> return", async () => {
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
				{
					path: "src/app.ts",
					status: " M",
					indexBlob: "b".repeat(40),
					content: "export const a = 2;\n",
				},
			]);
			clock.advance(6_000);
			const r = await running;

			expect(r.status).toBe("timeout");
			expect(r.gate?.decision).toBe("reject");
			expect(r.orchestration?.action).toBe("return");
			// §20 Run 4: workspace evidence remains intact through a timeout.
			expect(r.workspaceEvidence).toBeDefined();
			expect(r.verification?.state).toBe("satisfied");
		} finally {
			git.cleanup();
		}
	});

	test("aborted -> reject -> return", async () => {
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
			const running = harness.run(spec({ completionChecks: EXACT_APP }), controller.signal);
			await git.waitForCall((a) => a.join(" ").startsWith("status"));
			controller.abort();
			release();
			const r = await running;

			expect(r.status).toBe("aborted");
			expect(r.orchestration?.action).toBe("return");
			expect(r.orchestration?.reasonCode).toBe("gate-rejected");
		} finally {
			release?.();
			git.cleanup();
		}
	});

	test("error -> reject -> return", async () => {
		const git = createFakeGit({ files: BASE });
		try {
			const harness = new WorkerHarness({
				cwd: git.dir,
				gitRunner: git.runner,
				createSession: async () =>
					asSession(new FakeWorkerSession({ promptError: new Error("boom") })),
			});
			const r = await harness.run(spec({ completionChecks: EXACT_APP }));
			expect(r.status).toBe("error");
			expect(r.orchestration?.action).toBe("return");
			expect(r.orchestration?.reasonCode).toBe("gate-rejected");
		} finally {
			git.cleanup();
		}
	});
});

describe("Gate decision drives the action, not the raw evidence", () => {
	test("an injected policy flips the action input without the Orchestrator noticing", async () => {
		// Identical Worker behaviour and identical unsatisfied verification; only
		// the policy differs. The Orchestrator follows the Gate's conclusion.
		const strict = await runChangingApp({}, { completionChecks: WRONG_FILE });
		const relaxed = await runChangingApp(
			{
				gatePolicy: {
					requireExecutionCompleted: true,
					requireVerificationSatisfied: false,
				},
			},
			{ completionChecks: WRONG_FILE },
		);

		expect(strict.verification?.state).toBe("unsatisfied");
		expect(relaxed.verification?.state).toBe("unsatisfied");
		expect(strict.gate?.decision).toBe("reject");
		expect(relaxed.gate?.decision).toBe("accept");
		expect(strict.orchestration?.reasonCode).toBe("gate-rejected");
		expect(relaxed.orchestration?.reasonCode).toBe("gate-accepted");
		// Both still return — the action vocabulary does not distinguish them.
		expect(strict.orchestration?.action).toBe(relaxed.orchestration?.action);
	});
});

describe("Lifecycle boundary (§11, §12)", () => {
	test("the Worker session is already disposed when orchestration runs", async () => {
		const git = createFakeGit({ files: BASE });
		try {
			let workerStateAtDispose: string | undefined;
			let busyAtDispose: unknown = "unset";
			let fake: FakeWorkerSession | undefined;

			const harness = new WorkerHarness({
				cwd: git.dir,
				gitRunner: git.runner,
				createSession: async () => {
					fake = new FakeWorkerSession({ text: "done" });
					const original = fake.dispose.bind(fake);
					// dispose() is the last Worker-touching step before the pure
					// verify -> gate -> orchestrate chain runs synchronously, so
					// sampling here shows the state orchestration starts from.
					fake.dispose = () => {
						workerStateAtDispose = harness.activeWorker?.state;
						busyAtDispose = harness.isBusy;
						original();
					};
					return asSession(fake);
				},
			});
			const r = await harness.run(spec({ completionChecks: EXACT_APP }));

			// The Worker is in a terminal state — no live session to interfere.
			expect(workerStateAtDispose).toMatch(/FINISHED|ABORTED|TIMED_OUT|FAILED/);
			expect(workerStateAtDispose).not.toBe("LLM_GENERATING");
			expect(workerStateAtDispose).not.toBe("TOOL_RUNNING");
			// ...and the slot is still held, so orchestration happens inside it.
			expect(busyAtDispose).toBe(true);
			expect(r.orchestration).toBeDefined();
			expect(fake?.disposeCount).toBe(1);
		} finally {
			git.cleanup();
		}
	});

	test("a second run cannot start while the first is being orchestrated", async () => {
		const git = createFakeGit({ files: BASE });
		try {
			let second: Promise<Awaited<ReturnType<WorkerHarness["run"]>>> | undefined;
			let sessions = 0;
			const harness = new WorkerHarness({
				cwd: git.dir,
				gitRunner: git.runner,
				createSession: async () => {
					sessions += 1;
					const fake = new FakeWorkerSession({ text: "done" });
					const original = fake.dispose.bind(fake);
					fake.dispose = () => {
						original();
						// Re-enter while the first run is inside verify/gate/orchestrate.
						second ??= harness.run(spec({ taskId: "o-2" }));
					};
					return asSession(fake);
				},
			});
			const first = await harness.run(spec({ completionChecks: EXACT_APP }));
			expect(first.orchestration).toBeDefined();

			// The harness reports busyness as an error result rather than a
			// rejection, so check the result rather than the promise state.
			const secondResult = await second!;
			expect(secondResult.status).toBe("error");
			expect(secondResult.error).toMatch(/busy/i);
			// No second Worker session was ever created.
			expect(sessions).toBe(1);
		} finally {
			git.cleanup();
		}
	});

	test("the slot is released once orchestration returns", async () => {
		const git = createFakeGit({ files: BASE });
		try {
			const harness = new WorkerHarness({
				cwd: git.dir,
				gitRunner: git.runner,
				createSession: async () => asSession(new FakeWorkerSession({ text: "done" })),
			});
			await harness.run(spec({ completionChecks: EXACT_APP }));
			expect(harness.isBusy).toBe(false);
			expect(harness.activeWorker).toBeNull();
			expect(harness.activeTask).toBeNull();

			const second = await harness.run(spec({ taskId: "o-2" }));
			expect(second.orchestration).toBeDefined();
		} finally {
			git.cleanup();
		}
	});
});

describe("No retry (§19 L)", () => {
	for (const [name, specOverrides, expected] of [
		["reject", { completionChecks: WRONG_FILE }, "reject"],
		["inspect", { completionChecks: undefined }, "inspect"],
	] as const) {
		test(`${name} launches exactly one Worker session`, async () => {
			const git = createFakeGit({ files: BASE });
			let sessions = 0;
			try {
				const harness = new WorkerHarness({
					cwd: git.dir,
					gitRunner: git.runner,
					createSession: async () => {
						sessions += 1;
						return asSession(
							new FakeWorkerSession({
								text: "done",
								gate: new Promise<void>((r) => setTimeout(r, 0)),
							}),
						);
					},
				});
				const r = await harness.run(spec(specOverrides as Partial<TaskSpec>));
				expect(r.gate?.decision).toBe(expected);
				expect(sessions).toBe(1);
			} finally {
				git.cleanup();
			}
		});
	}

	test("ten inspected runs produce exactly ten sessions, never eleven", async () => {
		const git = createFakeGit({ files: BASE });
		let sessions = 0;
		try {
			const harness = new WorkerHarness({
				cwd: git.dir,
				gitRunner: git.runner,
				createSession: async () => {
					sessions += 1;
					return asSession(new FakeWorkerSession({ text: "done" }));
				},
			});
			for (let i = 0; i < 10; i++) {
				const r = await harness.run(
					spec({ taskId: `t${i}`, completionChecks: undefined }),
				);
				expect(r.orchestration?.action).toBe("inspect");
			}
			expect(sessions).toBe(10);
		} finally {
			git.cleanup();
		}
	});
});

describe("Evidence preservation on the result (§9)", () => {
	test("all four layers sit side by side on one WorkerResult", async () => {
		const r = await runChangingApp({}, { completionChecks: WRONG_FILE });
		expect(r.status).toBe("completed");
		expect(r.workspaceEvidence).toBeDefined();
		expect(r.verification?.state).toBe("unsatisfied");
		expect(r.gate?.decision).toBe("reject");
		expect(r.orchestration?.action).toBe("return");
		// The Gate's own reasons pass through untouched.
		expect(r.orchestration?.gateReasonCodes).toEqual([...(r.gate?.reasonCodes ?? [])]);
		expect(r.orchestration?.gateReasonCodes).toContain("verification-unsatisfied");
	});

	test("orchestration is purely additive to the gated result", async () => {
		const r = await runChangingApp({}, { completionChecks: EXACT_APP });
		const withoutOrchestration = { ...r } as Record<string, unknown>;
		delete withoutOrchestration.orchestration;
		// Strip the new field and a fully-formed Step 9 result remains.
		expect(withoutOrchestration.gate).toBeDefined();
		expect(withoutOrchestration.verification).toBeDefined();
		expect(withoutOrchestration.workspaceEvidence).toBeDefined();
		expect(withoutOrchestration.status).toBe("completed");
	});

	test("the decision survives JSON serialization", async () => {
		const r = await runChangingApp({}, { completionChecks: WRONG_FILE });
		expect(JSON.parse(JSON.stringify(r.orchestration))).toEqual(r.orchestration);
	});
});
