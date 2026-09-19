import { spawnSync } from "node:child_process";

import { Type, type Static } from "typebox";

/**
 * Deterministic completion verification (Step 8).
 *
 * The verifier consumes two independent evidence channels produced upstream:
 *
 *   - `WorkspaceEvidence` (Step 7) — what the workspace actually did
 *   - validation command results  — what an explicitly requested check reported
 *
 * It compares them against **explicitly structured, machine-checkable
 * requirements**. It never interprets prose. A requirement that cannot be
 * mechanically established is `unverifiable`, which is deliberately neither
 * `satisfied` nor `unsatisfied`: unknown is kept unknown rather than being
 * collapsed into a guess.
 *
 * The verifier is observational. It cannot steer, abort, retry, repair, revert,
 * clean, checkout, stash, commit or reset. It never mutates the repository.
 */

export type VerificationState = "satisfied" | "unsatisfied" | "unverifiable";

/**
 * Requirement kinds supported in v0 are the literals used in the schemas below:
 * `changed-files`, `forbidden-files`, `no-changes`, `command`, `test`.
 *
 * Deliberately a closed, small set. There is no expression language: no AND, OR,
 * NOT, nesting or arbitrary predicates. A new kind is added only when a concrete
 * TaskSpec needs it.
 */

/**
 * `changed-files`: compare the Worker-induced change set.
 *
 * `exact`    — observed set == expected set, no more and no less.
 * `includes` — expected set is a subset of the observed set.
 *
 * Always compared against the Worker-induced change set from Step 7, never the
 * whole repository diff, so pre-existing dirt cannot skew the result.
 */
export const ChangedFilesRequirementSchema = Type.Object({
	id: Type.String(),
	kind: Type.Literal("changed-files"),
	paths: Type.Array(Type.String()),
	mode: Type.Union([Type.Literal("exact"), Type.Literal("includes")], {
		default: "exact",
	}),
});

/**
 * `forbidden-files`: the intersection of the Worker-induced change set and the
 * forbidden paths must be empty.
 *
 * This is an observation of resulting changes. It is a different layer from the
 * Step 3 work boundary, which prevents tool execution before it happens. Both may
 * apply to the same run; neither substitutes for the other.
 */
export const ForbiddenFilesRequirementSchema = Type.Object({
	id: Type.String(),
	kind: Type.Literal("forbidden-files"),
	paths: Type.Array(Type.String()),
});

/**
 * `no-changes`: the Worker-induced change set must be empty.
 *
 * Compared against Worker-induced changes, NOT against `git status` cleanliness: a
 * repository that was already dirty before the Worker started satisfies this
 * requirement as long as the Worker itself changed nothing.
 */
export const NoChangesRequirementSchema = Type.Object({
	id: Type.String(),
	kind: Type.Literal("no-changes"),
});

/**
 * `command` / `test`: run an argv-based validation command and read its exit code.
 *
 * `argv` is an argument vector, not a shell string. `argv[0]` is the executable
 * and the rest are its arguments; no shell is involved, so `&&`, `|`, `;` and
 * backticks are passed through as literal arguments rather than being composed.
 *
 * `test` is the same mechanism with test-oriented intent. There is no internal
 * behavioural difference between `command` and `test`.
 */
export const ValidationCommandRequirementSchema = Type.Object({
	id: Type.String(),
	kind: Type.Union([Type.Literal("command"), Type.Literal("test")]),
	argv: Type.Array(Type.String(), { minItems: 1 }),
	cwd: Type.Optional(Type.String()),
	/** Per-command override of the harness verification timeout. */
	timeoutMs: Type.Optional(Type.Number()),
});

export const VerificationRequirementSchema = Type.Union([
	ChangedFilesRequirementSchema,
	ForbiddenFilesRequirementSchema,
	NoChangesRequirementSchema,
	ValidationCommandRequirementSchema,
]);

export type VerificationRequirement = Static<typeof VerificationRequirementSchema>;

/** A single requirement's verification outcome. */
export interface VerificationCheck {
	id: string;
	kind: string;
	state: VerificationState;
	/** What the requirement asked for, as a plain value. */
	expected?: unknown;
	/** What the evidence showed, as a plain value. */
	observed?: unknown;
	/** Deterministic explanation. Never LLM-generated. */
	reason?: string;
}

/**
 * Outcome of one validation command execution.
 *
 * `stdout` / `stderr` are capped. The cap is a fact about the evidence, not a
 * detail of how it was produced, so it is recorded rather than dropped: a
 * consumer must be able to tell "the command printed nothing" from "the command
 * printed a great deal and only the head was kept". Same shape of guarantee as
 * `PatchEvidence.truncated`.
 */
export interface CommandVerification {
	commandId: string;
	argv: readonly string[];
	/** Process exit code, or null when the process never produced one. */
	exitCode: number | null;
	timedOut: boolean;
	stdout?: string;
	stderr?: string;
	/** True when `stdout` was cut at `outputByteLimit`. */
	stdoutTruncated?: boolean;
	/** True when `stderr` was cut at `outputByteLimit`. */
	stderrTruncated?: boolean;
	/** Per-stream byte cap that was applied. */
	outputByteLimit?: number;
	state: VerificationState;
	reason?: string;
}

/**
 * Aggregate verification evidence.
 *
 * `state` summarizes the verification PROCESS under the aggregation rule in
 * `aggregateStates`. It is not a verdict on the Worker: `unsatisfied` means "an
 * explicitly stated condition was not observed", not "the Worker is bad", and
 * `unverifiable` means "nothing here was machine-checkable".
 */
export interface VerificationEvidence {
	state: VerificationState;
	checks: readonly VerificationCheck[];
	validation: readonly CommandVerification[];
	/** Deterministic notes about coverage, e.g. legacy prose criteria. */
	notes: readonly string[];
}

/**
 * Aggregation rule (§23).
 *
 *   any unsatisfied  -> unsatisfied
 *   else any unverifiable -> unverifiable
 *   else -> satisfied
 *
 * An empty check list is `unverifiable`: with nothing checkable there is nothing
 * to establish, which is unknown rather than success.
 */
export function aggregateStates(states: readonly VerificationState[]): VerificationState {
	if (states.length === 0) return "unverifiable";
	if (states.some((s) => s === "unsatisfied")) return "unsatisfied";
	if (states.some((s) => s === "unverifiable")) return "unverifiable";
	return "satisfied";
}

/** Raw result of running one validation command. */
export interface CommandRunResult {
	/** False when the executable could not be launched at all. */
	started: boolean;
	exitCode: number | null;
	timedOut: boolean;
	stdout: string;
	stderr: string;
}

export interface CommandRunOptions {
	cwd: string;
	timeoutMs: number;
}

/**
 * Injectable validation-command seam.
 *
 * Tests drive this with canned results and a virtual clock; production uses
 * `spawnCommandRunner`.
 */
export interface CommandRunner {
	run(argv: readonly string[], options: CommandRunOptions): CommandRunResult;
}

/**
 * Per-stream cap on retained command output.
 *
 * Truncation is reported structurally: `CommandVerification` carries
 * `stdoutTruncated`, `stderrTruncated` and the `outputByteLimit` that was
 * applied, so a truncated stream is distinguishable from a short one.
 */
export const DEFAULT_MAX_COMMAND_OUTPUT_BYTES = 32 * 1024;

/**
 * Runs a validation command with `spawnSync`.
 *
 * Chosen because it is the simplest runtime mechanism that is simultaneously:
 *   - argv-based (no shell, so no accidental shell composition),
 *   - bounded (the `timeout` option kills the child; it cannot run forever),
 *   - synchronous (verification runs after Worker teardown, while the N=1 slot is
 *     held anyway, so there is nothing else in-process to block).
 *
 * `shell: false` is set explicitly so no shell is ever involved.
 */
export const spawnCommandRunner: CommandRunner = {
	run(argv, options) {
		const executable = argv[0];
		if (executable === undefined || executable === "") {
			return {
				started: false,
				exitCode: null,
				timedOut: false,
				stdout: "",
				stderr: "empty argv: no executable specified",
			};
		}
		try {
			const result = spawnSync(executable, argv.slice(1), {
				cwd: options.cwd,
				timeout: options.timeoutMs,
				shell: false,
				encoding: "utf8",
				maxBuffer: 64 * 1024 * 1024,
			});
			const error = result.error as NodeJS.ErrnoException | undefined;
			// spawnSync reports a killed-by-timeout child as ETIMEDOUT.
			const timedOut = error?.code === "ETIMEDOUT";
			if (error != null && result.status === null && !timedOut) {
				// Could not launch (ENOENT, EACCES, ...).
				return {
					started: false,
					exitCode: null,
					timedOut: false,
					stdout: result.stdout ?? "",
					stderr: String(error.message ?? error),
				};
			}
			return {
				started: true,
				exitCode: result.status ?? null,
				timedOut,
				stdout: result.stdout ?? "",
				stderr: result.stderr ?? (error ? String(error.message ?? error) : ""),
			};
		} catch (error) {
			return {
				started: false,
				exitCode: null,
				timedOut: false,
				stdout: "",
				stderr: String(error),
			};
		}
	},
};

/**
 * Default bound on a single validation command.
 *
 * Independent of the Worker timeout: verification happens after the Worker is
 * gone, so it needs its own finite budget. Deliberately finite — an unbounded
 * validation command could hold the N=1 slot open forever.
 */
export const DEFAULT_VERIFICATION_COMMAND_TIMEOUT_MS = 120_000;
