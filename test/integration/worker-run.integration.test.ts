import { describe, expect, test } from "vitest";

import { WorkerHarness } from "../../src/worker-harness.ts";
import type { TaskSpec } from "../../src/task-spec.ts";

/**
 * Integration tests exercise the real `createAgentSession()` and, for the full
 * run, a real model. They are skipped unless explicitly enabled:
 *
 *   PI_WORKER_INTEGRATION=1 PI_WORKER_PROVIDER=... PI_WORKER_MODEL=... npm run test:integration
 */
const enabled = process.env.PI_WORKER_INTEGRATION === "1";
const reason = "set PI_WORKER_INTEGRATION=1 (and PI_WORKER_PROVIDER / PI_WORKER_MODEL) to run";

const trivialSpec: TaskSpec = {
	taskId: "int-trivial",
	goal: "Reply with exactly the text WORKER_OK and nothing else.",
	scope: [],
	workType: "investigate",
	completionCriteria: ["the final message contains WORKER_OK"],
	forbiddenChanges: ["No file modifications are allowed."],
};

describe.skipIf(!enabled)(`worker_run integration (${reason})`, () => {
	test(
		"a real Worker session is created with an empty, independent context",
		async () => {
			const harness = new WorkerHarness({
				cwd: process.cwd(),
				provider: process.env.PI_WORKER_PROVIDER,
				modelId: process.env.PI_WORKER_MODEL,
				thinkingLevel: "off",
			});

			const result = await harness.run({
				...trivialSpec,
				goal: "Reply with exactly the text WORKER_OK and nothing else. Do not use any tools.",
			});

			expect(result.error ?? "").not.toContain("session creation failed");
			expect(["completed", "aborted", "error"]).toContain(result.status);
		},
		600_000,
	);

	test(
		"a real Worker reaches agent_settled and returns its response",
		async () => {
			const harness = new WorkerHarness({
				cwd: process.cwd(),
				provider: process.env.PI_WORKER_PROVIDER,
				modelId: process.env.PI_WORKER_MODEL,
				thinkingLevel: "off",
			});

			const result = await harness.run(trivialSpec);

			expect(result.status).toBe("completed");
			expect(result.finalResponse).toContain("WORKER_OK");
			expect(result.taskId).toBe("int-trivial");
		},
		600_000,
	);
});
