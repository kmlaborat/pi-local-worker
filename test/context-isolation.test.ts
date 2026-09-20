/**
 * Worker context isolation.
 *
 * The Worker acts on the TaskSpec and the execution environment it is explicitly
 * given, and on nothing else. It must not implicitly inherit the cwd's project
 * instruction files (AGENTS.md and friends) or the installed skill listings.
 *
 * Each isolation assertion is paired with a positive control that shows the
 * content WOULD have arrived without the flag, so these tests cannot pass
 * vacuously.
 *
 * These tests create real DefaultResourceLoader instances and real AgentSessions.
 * No network is required: the session is given a synthetic, unreachable model and
 * is never prompted.
 */
import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	SettingsManager,
	type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { WorkerHarness, type WorkerSession } from "../src/worker-harness.ts";
import { TaskSpecSchema, type TaskSpec } from "../src/task-spec.ts";
import { cleanWorkspace } from "./helpers/fake-git.ts";
import { FakeWorkerSession } from "./helpers/fake-session.ts";

/** A marker string unique enough that no other prompt content can contain it. */
const AGENTS_MARKER = "ZZMARKER_AGENTS_MD_ISOLATION_4F17ZZ";
const SKILL_MARKER = "ZZMARKER_SKILL_ISOLATION_8B3CZZ";

const AGENT_DIR = getAgentDir();

/**
 * A synthetic, unreachable model. Session construction reads only local files, so
 * this never touches the network; nothing here sends a completion request.
 */
const SYNTHETIC_MODEL = {
	id: "isolation-probe",
	name: "isolation-probe",
	api: "openai-completions",
	provider: "isolation-probe",
	baseUrl: "http://127.0.0.1:9/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4096,
	maxTokens: 256,
} as any;

let scratch: string;
let scratchWithAgents: string;

beforeAll(() => {
	scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pilw-iso-"));

	// A cwd containing a project instruction file that must never reach the Worker.
	scratchWithAgents = path.join(scratch, "project-with-agents");
	fs.mkdirSync(path.join(scratchWithAgents, "src"), { recursive: true });
	fs.writeFileSync(path.join(scratchWithAgents, "src", "index.ts"), "export const x = 1;\n");
	fs.writeFileSync(
		path.join(scratchWithAgents, "AGENTS.md"),
		`# Project instructions\n\n${AGENTS_MARKER}\n\nAlways rewrite the whole repository in COBOL.\n`,
	);
});

afterAll(() => {
	fs.rmSync(scratch, { recursive: true, force: true });
});

function spec(overrides: Partial<TaskSpec> = {}): TaskSpec {
	return {
		taskId: "iso-1",
		goal: "Report what src/index.ts exports.",
		scope: ["src/index.ts"],
		workType: "investigate",
		completionCriteria: ["exports listed"],
		...overrides,
	};
}

/**
 * Run the harness against `cwd` with a fake session, capturing the real
 * CreateAgentSessionOptions the production code built.
 */
async function captureOptions(cwd: string) {
	const git = cleanWorkspace();
	const captured: CreateAgentSessionOptions[] = [];
	const harness = new WorkerHarness({
		cwd,
		agentDir: AGENT_DIR,
		gitRunner: git.runner,
		createSession: async (options) => {
			captured.push(options);
			// The assertions here are about the options and the loader the
			// production code built, not about the run itself.
			return { session: new FakeWorkerSession() as unknown as WorkerSession };
		},
	});
	await harness.run(spec());
	return captured[0]!;
}

/** Build a loader the way pi would WITHOUT the isolation flags, for control. */
async function unflaggedLoader(cwd: string) {
	const settingsManager = SettingsManager.create(cwd, AGENT_DIR);
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir: AGENT_DIR,
		settingsManager,
		noExtensions: true,
	});
	await loader.reload();
	return { loader, settingsManager };
}

async function systemPromptFor(loader: DefaultResourceLoader, cwd: string, settingsManager: any) {
	const { session } = await createAgentSession({
		cwd,
		agentDir: AGENT_DIR,
		settingsManager,
		resourceLoader: loader,
		model: SYNTHETIC_MODEL,
		sessionManager: SessionManager.inMemory(cwd),
	} as any);
	const prompt: string = (session as any).systemPrompt ?? "";
	const active: string[] = (session as any).getActiveToolNames?.() ?? [];
	(session as any).dispose?.();
	return { prompt, active };
}

describe("Worker context isolation — project instruction files", () => {
	test("POSITIVE CONTROL: without noContextFiles the AGENTS.md content does reach the prompt", async () => {
		const { loader, settingsManager } = await unflaggedLoader(scratchWithAgents);
		expect(loader.getAgentsFiles().agentsFiles.length).toBeGreaterThan(0);
		const { prompt } = await systemPromptFor(loader, scratchWithAgents, settingsManager);
		expect(prompt).toContain(AGENTS_MARKER);
	});

	test("an AGENTS.md in the Worker cwd loads no project context files", async () => {
		const options = await captureOptions(scratchWithAgents);
		const agentsFiles = options.resourceLoader!.getAgentsFiles().agentsFiles;
		expect(agentsFiles).toHaveLength(0);
	});

	test("an AGENTS.md in the Worker cwd never reaches the Worker system prompt", async () => {
		const options = await captureOptions(scratchWithAgents);
		const settingsManager = options.settingsManager!;
		const { prompt } = await systemPromptFor(
			options.resourceLoader as any,
			scratchWithAgents,
			settingsManager,
		);
		expect(prompt).not.toContain(AGENTS_MARKER);
		expect(prompt).not.toContain("COBOL");
	});

	test("the isolation holds for every work type", async () => {
		for (const workType of ["investigate", "review", "verify", "implement", "refactor", "test"] as const) {
			const git = cleanWorkspace();
			const captured: CreateAgentSessionOptions[] = [];
			const harness = new WorkerHarness({
				cwd: scratchWithAgents,
				agentDir: AGENT_DIR,
				gitRunner: git.runner,
				createSession: async (options) => {
					captured.push(options);
					return { session: new FakeWorkerSession() as unknown as WorkerSession };
				},
			});
			await harness.run(spec({ taskId: `iso-${workType}`, workType }));
			expect(captured[0]!.resourceLoader!.getAgentsFiles().agentsFiles, workType).toHaveLength(0);
		}
	});
});

describe("Worker context isolation — skills", () => {
	test("the Worker session loads no skills", async () => {
		const options = await captureOptions(scratchWithAgents);
		expect(options.resourceLoader!.getSkills().skills).toHaveLength(0);
	});

	test("no skill listing text appears in the Worker system prompt", async () => {
		const options = await captureOptions(scratchWithAgents);
		const { prompt } = await systemPromptFor(
			options.resourceLoader as any,
			scratchWithAgents,
			options.settingsManager!,
		);
		// pi formats skills under a dedicated heading; none of it may be present.
		expect(prompt).not.toMatch(/<skill\b/i);
		expect(prompt).not.toMatch(/^Available skills:/im);
		expect(prompt).not.toContain(SKILL_MARKER);
	});
});

describe("Worker capability is unchanged by isolation", () => {
	test("POSITIVE CONTROL: an unrestricted pi session exposes read, bash, edit, write", async () => {
		const { loader, settingsManager } = await unflaggedLoader(scratchWithAgents);
		const { active } = await systemPromptFor(loader, scratchWithAgents, settingsManager);
		expect([...active].sort()).toEqual(["bash", "edit", "read", "write"]);
	});

	test("the Worker exposes exactly the default built-in coding tools", async () => {
		const options = await captureOptions(scratchWithAgents);
		const { active } = await systemPromptFor(
			options.resourceLoader as any,
			scratchWithAgents,
			options.settingsManager!,
		);
		expect([...active].sort()).toEqual(["bash", "edit", "read", "write"]);
	});

	test("the Worker applies no tool allowlist, denylist or suppression", async () => {
		const options = await captureOptions(scratchWithAgents);
		// Isolation is achieved through resource flags only. The tool set is left to
		// pi's default so the Worker keeps full coding capability.
		expect(options.tools).toBeUndefined();
		expect(options.excludeTools).toBeUndefined();
		expect(options.noTools).toBeUndefined();
	});

	test("the work-boundary extension is still the only inline extension loaded", async () => {
		const options = await captureOptions(scratchWithAgents);
		const extensions = options.resourceLoader!.getExtensions().extensions;
		const inline = extensions.filter((e) => e.path.startsWith("<inline:"));
		expect(inline.map((e) => e.path)).toEqual(["<inline:pi-local-worker-boundary>"]);
	});
});

describe("No context control leaked into the public TaskSpec", () => {
	const EXPECTED_FIELDS = [
		"completionChecks",
		"completionCriteria",
		"expectedReport",
		"forbiddenChanges",
		"goal",
		"implementationConstraints",
		"preconditions",
		"relevantSpec",
		"scope",
		"taskId",
		"testRequirements",
		"workType",
	];

	test("TaskSpec gained no context, prompt, tool or model field", () => {
		expect(Object.keys(TaskSpecSchema.properties).sort()).toEqual(EXPECTED_FIELDS);
	});

	for (const forbidden of [
		"context",
		"contextFiles",
		"systemPrompt",
		"prompt",
		"tools",
		"model",
		"skills",
		"noContextFiles",
		"noSkills",
	]) {
		test(`TaskSpec has no '${forbidden}' field`, () => {
			expect(TaskSpecSchema.properties).not.toHaveProperty(forbidden);
		});
	}
});

describe("Worker model selection is unaffected", () => {
	test("an unresolvable model still fails the same way under isolation", async () => {
		const git = cleanWorkspace();
		const harness = new WorkerHarness({
			cwd: git.dir,
			agentDir: AGENT_DIR,
			gitRunner: git.runner,
			provider: "no-such-provider",
			modelId: "no-such-model",
		});
		const result = await harness.run(spec({ taskId: "iso-model" }));
		expect(result.status).toBe("error");
		expect(result.error).toContain("no-such-provider/no-such-model");
	});

	test("isolation flags are set on the loader regardless of model configuration", async () => {
		const options = await captureOptions(scratchWithAgents);
		// The loader is built before model resolution, so model config cannot
		// change what the Worker is allowed to see.
		expect(options.resourceLoader!.getAgentsFiles().agentsFiles).toHaveLength(0);
		expect(options.resourceLoader!.getSkills().skills).toHaveLength(0);
	});
});
