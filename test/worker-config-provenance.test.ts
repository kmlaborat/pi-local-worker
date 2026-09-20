/**
 * Worker model configuration and execution provenance.
 *
 * Two separate facts, deliberately kept separate:
 *
 *   worker  = which model the Worker runs on, from the configuration file
 *   parent  = which model invoked worker_run, read fresh from the calling
 *             Architect session at the moment of the call
 *
 * Neither influences the other. The tests below assert that independence as well
 * as each half on its own.
 */
import { describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
	WORKER_CONFIG_FILENAME,
	readWorkerConfig,
	resolveWorkerConfigPath,
} from "../src/worker-config.ts";
import {
	WorkerHarness,
	type ModelProvenance,
	type WorkerHarnessConfig,
	type WorkerSession,
} from "../src/worker-harness.ts";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import type { TaskSpec } from "../src/task-spec.ts";
import { cleanWorkspace } from "./helpers/fake-git.ts";

// ---------------------------------------------------------------------------
// config loader
// ---------------------------------------------------------------------------

/** Run the loader against an in-memory filesystem. */
function loadFrom(content: string | null, filename = WORKER_CONFIG_FILENAME) {
	const fakePath = path.join("/agent", filename);
	return readWorkerConfig({
		agentDir: "/agent",
		exists: () => content !== null,
		read: () => (content === null ? "" : content),
		// `path` in the result is derived from agentDir; assert on it separately.
	}) as unknown as { ok: boolean; config?: unknown; error?: string; path: string };
}

describe("worker-config — path resolution", () => {
	test("the file lives in the agent directory under a fixed name", () => {
		expect(resolveWorkerConfigPath("/tmp/agent")).toBe(
			path.join("/tmp/agent", "pi-local-worker-config.json"),
		);
	});

	test("the filename is the documented one", () => {
		expect(WORKER_CONFIG_FILENAME).toBe("pi-local-worker-config.json");
	});
});

describe("worker-config — valid configuration", () => {
	const VALID = JSON.stringify({ worker: { provider: "alpha", model: "worker-model" } });

	test("1. a valid config is read", () => {
		const r = loadFrom(VALID);
		expect(r.ok).toBe(true);
	});

	test("2. worker.provider is returned", () => {
		const r = loadFrom(VALID);
		expect((r.config as { provider: string }).provider).toBe("alpha");
	});

	test("3. worker.model is returned", () => {
		const r = loadFrom(VALID);
		expect((r.config as { model: string }).model).toBe("worker-model");
	});

	test("surrounding whitespace is trimmed", () => {
		const r = loadFrom(JSON.stringify({ worker: { provider: "  alpha  ", model: "  x  " } }));
		expect(r.ok).toBe(true);
		expect((r.config as { provider: string; model: string }).provider).toBe("alpha");
		expect((r.config as { provider: string; model: string }).model).toBe("x");
	});

	test("unknown extra keys are ignored, not rejected", () => {
		const r = loadFrom(
			JSON.stringify({ worker: { provider: "p", model: "m" }, futureField: { a: 1 } }),
		);
		expect(r.ok).toBe(true);
	});
});

describe("worker-config — failure modes", () => {
	test("4. a missing file is an explicit error naming the path", () => {
		const r = loadFrom(null);
		expect(r.ok).toBe(false);
		expect(r.error).toContain("not found");
		expect(r.error).toContain(WORKER_CONFIG_FILENAME);
	});

	test("5. invalid JSON is an explicit error", () => {
		const r = loadFrom("{ not json");
		expect(r.ok).toBe(false);
		expect(r.error).toContain("not valid JSON");
	});

	test("6. a missing `worker` object is an error", () => {
		const r = loadFrom(JSON.stringify({ provider: "alpha", model: "x" }));
		expect(r.ok).toBe(false);
		expect(r.error).toContain('"worker"');
	});

	test("7. a missing provider is an error", () => {
		const r = loadFrom(JSON.stringify({ worker: { model: "x" } }));
		expect(r.ok).toBe(false);
		expect(r.error).toContain("worker.provider");
	});

	test("7b. a missing model is an error", () => {
		const r = loadFrom(JSON.stringify({ worker: { provider: "alpha" } }));
		expect(r.ok).toBe(false);
		expect(r.error).toContain("worker.model");
	});

	test("an empty provider is rejected", () => {
		const r = loadFrom(JSON.stringify({ worker: { provider: "   ", model: "x" } }));
		expect(r.ok).toBe(false);
		expect(r.error).toContain("worker.provider");
	});

	test("a non-string provider is rejected", () => {
		const r = loadFrom(JSON.stringify({ worker: { provider: 42, model: "x" } }));
		expect(r.ok).toBe(false);
	});

	test("a null `worker` is rejected", () => {
		const r = loadFrom(JSON.stringify({ worker: null }));
		expect(r.ok).toBe(false);
	});

	test("an array root is rejected", () => {
		const r = loadFrom(JSON.stringify([{ worker: { provider: "p", model: "m" } }]));
		expect(r.ok).toBe(false);
	});

	test("every failure still reports the path consulted", () => {
		for (const bad of ["{", '{"worker":null}', "{}", '{"worker":{}}']) {
			const r = loadFrom(bad);
			expect(r.ok).toBe(false);
			expect(r.path).toContain(WORKER_CONFIG_FILENAME);
		}
	});
});

// ---------------------------------------------------------------------------
// harness: worker model wiring
// ---------------------------------------------------------------------------

function spec(overrides: Partial<TaskSpec> = {}): TaskSpec {
	return {
		taskId: "cfg-1",
		goal: "Do the thing.",
		scope: ["src/thing.ts"],
		workType: "implement",
		completionCriteria: ["done"],
		...overrides,
	};
}

interface Captured {
	options: CreateAgentSessionOptions[];
	sessions: unknown[];
}

function harnessWith(
	config: Partial<WorkerHarnessConfig> = {},
	captured: Captured = { options: [], sessions: [] },
) {
	const git = cleanWorkspace();
	const harness = new WorkerHarness({
		cwd: git.dir,
		gitRunner: git.runner,
		createSession: async (options) => {
			captured.options.push(options);
			const session = new FakeSession();
			captured.sessions.push(session);
			return { session: session as unknown as WorkerSession };
		},
		...config,
	});
	return { harness, captured };
}

/** Minimal session that settles immediately. */
class FakeSession {
	public state = { pendingToolCalls: new Set<string>(), errorMessage: undefined as string | undefined };
	public messages: readonly unknown[] = [];
	subscribe(listener: (event: any) => void) {
		queueMicrotask(() => listener({ type: "agent_start" }));
		queueMicrotask(() => listener({ type: "agent_settled" }));
		return () => {};
	}
	async prompt() {}
	async waitForIdle() {}
	async steer() {}
	async sendUserMessage() {}
	async abort() {}
	get isStreaming() {
		return false;
	}
	dispose() {}
}

describe("Worker model comes from configuration", () => {
	test("8. the configured provider/model reach the Worker session options", async () => {
		const { harness, captured } = harnessWith({ provider: "alpha", modelId: "worker-model" });
		// A modelRuntime stub so no real catalog lookup happens.
		const stubRuntime = { getModel: (p: string, m: string) => ({ provider: p, id: m }) };
		(harness as any).config.modelRuntime = stubRuntime;

		await harness.run(spec());
		expect(captured.options[0]!.model).toEqual({
			provider: "alpha",
			id: "worker-model",
		});
	});

	test("9. the Worker is not dragged onto the Architect's default model", async () => {
		// The Worker model is set explicitly; nothing about the caller can change it.
		const { harness, captured } = harnessWith({ provider: "alpha", modelId: "worker-model" });
		(harness as any).config.modelRuntime = {
			getModel: (p: string, m: string) => ({ provider: p, id: m }),
		};

		await harness.run(
			spec(),
			undefined,
			{ provider: "alpha", model: "parent-model" },
		);
		const model: any = captured.options[0]!.model;
		expect(model.id).toBe("worker-model");
		expect(model.id).not.toBe("parent-model");
	});

	test("10. the result records the actual Worker provider/model", async () => {
		const { harness } = harnessWith({ provider: "alpha", modelId: "worker-model" });
		(harness as any).config.modelRuntime = {
			getModel: (p: string, m: string) => ({ provider: p, id: m }),
		};

		const r = await harness.run(spec());
		expect(r.worker).toEqual({ provider: "alpha", model: "worker-model" });
	});
});

// ---------------------------------------------------------------------------
// parent provenance
// ---------------------------------------------------------------------------

describe("Parent provenance", () => {
	test("11. the invoking session's provider/model is recorded", async () => {
		const { harness } = harnessWith({ provider: "alpha", modelId: "worker-model" });
		(harness as any).config.modelRuntime = { getModel: (p: string, m: string) => ({ provider: p, id: m }) };

		const r = await harness.run(spec(), undefined, {
			provider: "alpha",
			model: "parent-model",
		});
		expect(r.parent).toEqual({ provider: "alpha", model: "parent-model" });
	});

	test("12. parent and worker are independent", async () => {
		const { harness } = harnessWith({ provider: "alpha", modelId: "worker-model" });
		(harness as any).config.modelRuntime = { getModel: (p: string, m: string) => ({ provider: p, id: m }) };

		const r = await harness.run(spec(), undefined, {
			provider: "beta",
			model: "parent-model",
		});
		expect(r.parent).toEqual({ provider: "beta", model: "parent-model" });
		expect(r.worker).toEqual({ provider: "alpha", model: "worker-model" });
		expect(r.parent!.model).not.toBe(r.worker!.model);
	});

	test("13. a changed Architect model is recorded per invocation", async () => {
		const { harness } = harnessWith({ provider: "alpha", modelId: "worker-model" });
		(harness as any).config.modelRuntime = { getModel: (p: string, m: string) => ({ provider: p, id: m }) };

		const first = await harness.run(spec({ taskId: "a" }), undefined, {
			provider: "p1",
			model: "model-one",
		});
		const second = await harness.run(spec({ taskId: "b" }), undefined, {
			provider: "p2",
			model: "model-two",
		});

		expect(first.parent).toEqual({ provider: "p1", model: "model-one" });
		expect(second.parent).toEqual({ provider: "p2", model: "model-two" });
		// Nothing leaked between runs.
		expect(second.parent).not.toEqual(first.parent);
	});

	test("14. the Worker model stays on the configured value across invocations", async () => {
		const { harness, captured } = harnessWith({ provider: "alpha", modelId: "worker-model" });
		(harness as any).config.modelRuntime = { getModel: (p: string, m: string) => ({ provider: p, id: m }) };

		const a = await harness.run(spec({ taskId: "a" }), undefined, { provider: "x", model: "y" });
		const b = await harness.run(spec({ taskId: "b" }), undefined, { provider: "z", model: "w" });

		expect(a.worker).toEqual({ provider: "alpha", model: "worker-model" });
		expect(b.worker).toEqual({ provider: "alpha", model: "worker-model" });
		const models = captured.options.map((o: any) => o.model.id);
		expect(models).toEqual(["worker-model", "worker-model"]);
	});

	test("no parent supplied means no parent field", async () => {
		const { harness } = harnessWith({ provider: "alpha", modelId: "worker-model" });
		(harness as any).config.modelRuntime = { getModel: (p: string, m: string) => ({ provider: p, id: m }) };
		const r = await harness.run(spec());
		expect(r.parent).toBeUndefined();
		expect(r.worker).toEqual({ provider: "alpha", model: "worker-model" });
	});

	test("parent and worker on the same provider are still recorded separately", async () => {
		const { harness } = harnessWith({ provider: "alpha", modelId: "worker-model" });
		(harness as any).config.modelRuntime = { getModel: (p: string, m: string) => ({ provider: p, id: m }) };

		const r = await harness.run(spec(), undefined, {
			provider: "alpha",
			model: "parent-model",
		});

		expect(r.parent).toEqual({ provider: "alpha", model: "parent-model" });
		expect(r.worker).toEqual({ provider: "alpha", model: "worker-model" });
	});

	test("provenance does not leak into a later run that supplies no parent", async () => {
		const { harness } = harnessWith({ provider: "alpha", modelId: "worker-model" });
		(harness as any).config.modelRuntime = { getModel: (p: string, m: string) => ({ provider: p, id: m }) };

		await harness.run(spec({ taskId: "a" }), undefined, { provider: "p1", model: "m1" });
		const next = await harness.run(spec({ taskId: "b" }));
		expect(next.parent).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// configuration failure
// ---------------------------------------------------------------------------

describe("Configuration failure refuses the run", () => {
	test("a configurationError is returned as an error result", async () => {
		const { harness, captured } = harnessWith({
			configurationError: "Worker configuration file not found: /x/pi-local-worker-config.json",
		});
		const r = await harness.run(spec());
		expect(r.status).toBe("error");
		expect(r.error).toContain("pi-local-worker-config.json");
		// No session was created.
		expect(captured.options).toHaveLength(0);
	});

	test("a configuration failure records no worker provenance", async () => {
		const { harness } = harnessWith({ configurationError: "no config" });
		const r = await harness.run(spec());
		expect(r.worker).toBeUndefined();
	});

	test("a configuration failure is reported on every call, not just the first", async () => {
		const { harness } = harnessWith({ configurationError: "no config" });
		const a = await harness.run(spec({ taskId: "a" }));
		const b = await harness.run(spec({ taskId: "b" }));
		expect(a.status).toBe("error");
		expect(b.status).toBe("error");
		expect(b.error).toBe("no config");
	});
});

// ---------------------------------------------------------------------------
// real file read through a temp agent directory
// ---------------------------------------------------------------------------

describe("Worker model resolution from a real config file", () => {
	test("a real file on disk resolves provider and model", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pilw-cfg-"));
		try {
			fs.writeFileSync(
				path.join(dir, WORKER_CONFIG_FILENAME),
				JSON.stringify({ worker: { provider: "alpha", model: "worker-model" } }),
			);
			const r = readWorkerConfig({ agentDir: dir });
			expect(r.ok).toBe(true);
			if (r.ok) {
				expect(r.config).toEqual({ provider: "alpha", model: "worker-model" });
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a real missing file resolves to a not-found error", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pilw-cfg-"));
		try {
			const r = readWorkerConfig({ agentDir: dir });
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.error).toContain("not found");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// TaskSpec untouched
// ---------------------------------------------------------------------------

describe("No model configuration leaked into TaskSpec", () => {
	test("TaskSpec has no provider, model or parent field", async () => {
		const { TaskSpecSchema } = await import("../src/task-spec.ts");
		for (const forbidden of ["provider", "model", "parent", "worker", "modelId"]) {
			expect(TaskSpecSchema.properties).not.toHaveProperty(forbidden);
		}
	});
});

// ---------------------------------------------------------------------------
// shape
// ---------------------------------------------------------------------------

describe("ModelProvenance shape", () => {
	test("provenance carries exactly provider and model", async () => {
		const { harness } = harnessWith({ provider: "p", modelId: "m" });
		(harness as any).config.modelRuntime = { getModel: (p: string, m: string) => ({ provider: p, id: m }) };
		const r = await harness.run(spec(), undefined, { provider: "pp", model: "mm" });
		const prov: ModelProvenance = r.parent!;
		expect(Object.keys(prov).sort()).toEqual(["model", "provider"]);
		expect(Object.keys(r.worker!).sort()).toEqual(["model", "provider"]);
	});
});
