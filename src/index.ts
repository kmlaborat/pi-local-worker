import { defineTool, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { TaskSpecSchema, type TaskSpec } from "./task-spec.ts";
import { WorkerHarness, type WorkerResult, type WorkerThinkingLevel } from "./worker-harness.ts";


const THINKING_LEVELS: readonly WorkerThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

/**
 * Single Worker slot for this extension instance.
 * v0 allows exactly one Worker at a time (no queue, no scheduler).
 */
export const workerHarness = new WorkerHarness({
	cwd: process.env.PI_WORKER_CWD ?? process.cwd(),
	provider: readEnv("PI_WORKER_PROVIDER"),
	modelId: readEnv("PI_WORKER_MODEL"),
	thinkingLevel: readThinkingLevel(),
	// Watchdog thresholds. Unset -> shipped defaults (SPEC §14: configurable,
	// never hard-coded). The core Harness API takes these as plain options; the
	// env vars only exist so an operator can tune the extension without code.
	watchdogIntervalMs: readPositiveIntEnv("PI_WORKER_WATCHDOG_INTERVAL_MS"),
	llmIdleThresholdMs: readPositiveIntEnv("PI_WORKER_LLM_IDLE_MS"),
	// Liveness boundary (Step 6). Unset -> DEFAULT_WORKER_TIMEOUT_MS.
	workerTimeoutMs: readPositiveIntEnv("PI_WORKER_TIMEOUT_MS"),
	drainGraceMs: readPositiveIntEnv("PI_WORKER_DRAIN_GRACE_MS"),
});

/**
 * The Architect-facing tool: TaskSpec in, Worker Harness, structured result out.
 *
 * Exported as a factory so the translation layer can be tested against a stub
 * harness without touching the real model runtime.
 */
export function createWorkerRunTool(harness: WorkerHarness): ToolDefinition {
	return defineTool({
		name: "worker_run",
		label: "Run Worker",
		description:
			"Delegate a self-contained task to an independent local Worker AgentSession. " +
			"The call blocks until the Worker reaches its settled state and returns a JSON result. " +
			"The Worker has no access to this conversation: everything it needs must be in the TaskSpec.",
		promptSnippet: "Delegate a self-contained task to an isolated local Worker session",
		promptGuidelines: [
			"worker_run tasks must be fully self-contained: the Worker cannot see this conversation.",
			"Only one worker_run can execute at a time; a second concurrent call is rejected.",
			"The result carries `gate` (policy decision) and `orchestration` (lifecycle action). `gate: reject` is not a retry trigger and not an error: the run is finished and the evidence is yours to act on. Any revised task is a new, explicit worker_run call.",
		],
		parameters: TaskSpecSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal) {
			const result: WorkerResult = await harness.run(params as TaskSpec, signal);
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				details: result,
			};
		},
	});
}

export default function (pi: ExtensionAPI) {
	pi.registerTool(createWorkerRunTool(workerHarness));
}

function readEnv(name: string): string | undefined {
	const value = process.env[name];
	return value && value.trim().length > 0 ? value.trim() : undefined;
}

function readPositiveIntEnv(name: string): number | undefined {
	const raw = readEnv(name);
	if (raw === undefined) return undefined;
	const value = Number(raw);
	return Number.isInteger(value) && value > 0 ? value : undefined;
}

function readThinkingLevel(): WorkerThinkingLevel | undefined {
	const value = readEnv("PI_WORKER_THINKING");
	if (!value) return undefined;
	return THINKING_LEVELS.includes(value as WorkerThinkingLevel)
		? (value as WorkerThinkingLevel)
		: undefined;
}


