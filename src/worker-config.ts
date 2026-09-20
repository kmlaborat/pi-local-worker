/**
 * Worker model configuration.
 *
 * The Worker's provider and model come from one place: a JSON file in pi's
 * user-level agent directory. This module owns exactly that job and nothing else:
 *
 *   - resolve the config path against pi's own agent-directory resolution
 *   - read the file
 *   - validate it
 *   - hand back `provider` and `model`
 *
 * It deliberately does not know about sessions, harnesses, models or the Worker
 * pipeline. It never throws: every outcome, including every failure, comes back as
 * a discriminated result so the caller can turn it into a precise diagnostic
 * rather than an exception that arrives with the wrong context.
 *
 * The path is resolved with pi's `getAgentDir()`, which honours the
 * `PI_CODING_AGENT_DIR` environment override and otherwise uses
 * `<home>/.pi/agent`. This module does not implement its own home-directory
 * logic, so it follows pi wherever pi's configuration location goes.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

/** File name within the agent directory. */
export const WORKER_CONFIG_FILENAME = "pi-local-worker-config.json";

/** The resolved Worker model configuration. */
export interface WorkerModelConfig {
	provider: string;
	model: string;
}

/**
 * Outcome of a configuration read.
 *
 * `path` is always present so a failure message can name the file that was
 * consulted, which is the first thing an operator needs.
 */
export type WorkerConfigResult =
	| { ok: true; config: WorkerModelConfig; path: string }
	| { ok: false; error: string; path: string };

/** Injectable filesystem seam so tests need not touch the real agent directory. */
export interface WorkerConfigReadOptions {
	/** Agent directory. Defaults to pi's `getAgentDir()`. */
	agentDir?: string;
	/** Defaults to `fs.existsSync`. */
	exists?: (path: string) => boolean;
	/** Defaults to `fs.readFileSync(path, "utf8")`. */
	read?: (path: string) => string;
}

/**
 * Absolute path of the Worker config file for `agentDir`.
 *
 * The default is pi's own agent directory, so an operator who relocates pi's
 * configuration with `PI_CODING_AGENT_DIR` moves this file with it.
 */
export function resolveWorkerConfigPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, WORKER_CONFIG_FILENAME);
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

/**
 * Read and validate the Worker configuration.
 *
 * Validation is explicit and each failure names what was wrong:
 *
 *   file absent              -> configuration file not found
 *   unparseable JSON         -> configuration file is not valid JSON
 *   non-object / array       -> configuration must be a JSON object
 *   `worker` absent          -> missing required "worker" object
 *   `worker` not an object   -> "worker" must be a JSON object
 *   `provider` absent/bad    -> worker.provider must be a non-empty string
 *   `model` absent/bad       -> worker.model must be a non-empty string
 *
 * Unknown extra keys are ignored: forward compatibility with future config
 * fields costs nothing and avoids failing an upgrade over a comment-like extra.
 */
export function readWorkerConfig(options: WorkerConfigReadOptions = {}): WorkerConfigResult {
	const path = resolveWorkerConfigPath(options.agentDir ?? getAgentDir());
	const exists = options.exists ?? existsSync;
	const read = options.read ?? ((p: string) => readFileSync(p, "utf8"));

	if (!exists(path)) {
		return {
			ok: false,
			path,
			error:
				`Worker configuration file not found: ${path}. ` +
				'Create it with { "worker": { "provider": "...", "model": "..." } }.',
		};
	}

	let raw: string;
	try {
		raw = read(path);
	} catch (error) {
		return {
			ok: false,
			path,
			error: `Worker configuration file could not be read: ${path} (${error instanceof Error ? error.message : String(error)})`,
		};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		return {
			ok: false,
			path,
			error: `Worker configuration is not valid JSON: ${path} (${error instanceof Error ? error.message : String(error)})`,
		};
	}

	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return {
			ok: false,
			path,
			error: `Worker configuration must be a JSON object: ${path}`,
		};
	}

	const worker = (parsed as Record<string, unknown>).worker;
	if (worker === undefined) {
		return {
			ok: false,
			path,
			error: `Worker configuration is missing the required "worker" object: ${path}`,
		};
	}
	if (worker === null || typeof worker !== "object" || Array.isArray(worker)) {
		return {
			ok: false,
			path,
			error: `Worker configuration "worker" must be a JSON object: ${path}`,
		};
	}

	const record = worker as Record<string, unknown>;
	if (!nonEmptyString(record.provider)) {
		return {
			ok: false,
			path,
			error: `Worker configuration "worker.provider" must be a non-empty string: ${path}`,
		};
	}
	if (!nonEmptyString(record.model)) {
		return {
			ok: false,
			path,
			error: `Worker configuration "worker.model" must be a non-empty string: ${path}`,
		};
	}

	return {
		ok: true,
		path,
		config: { provider: record.provider.trim(), model: record.model.trim() },
	};
}
