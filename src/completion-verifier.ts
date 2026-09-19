import {
	type CommandRunner,
	type CommandVerification,
	DEFAULT_MAX_COMMAND_OUTPUT_BYTES,
	type VerificationCheck,
	type VerificationEvidence,
	type VerificationRequirement,
	type VerificationState,
	aggregateStates,
} from "./verification.ts";

/**
 * Deterministic completion verification (Step 8).
 *
 * Compares explicitly structured requirements against two independent evidence
 * channels: Step 7 workspace evidence, and validation command results.
 *
 * It never interprets prose, never mutates the repository, and never influences
 * Worker execution. A requirement that cannot be mechanically established is
 * `unverifiable` — deliberately neither satisfied nor unsatisfied, so unknown
 * stays unknown instead of becoming a guess.
 */

// Work types whose default deterministic invariant is "no Worker-induced
// changes". Imported from task-spec.ts rather than restated here: this is the same
// classification the Step 3 work boundary enforces, and the two must not drift.
import { isReadOnlyWorkType, type WorkType } from "./task-spec.ts";

/** Requirement kinds that depend on workspace evidence. */
const WORKSPACE_KINDS = new Set(["changed-files", "forbidden-files", "no-changes"]);

/** The slice of Step 7 evidence this verifier needs. */
export interface WorkspaceEvidenceView {
	verificationStatus: "available" | "unavailable";
	changedFiles: readonly { path: string }[];
}

/**
 * Derive the machine-checkable requirement set for a TaskSpec.
 *
 * Only `completionChecks` is authoritative. The legacy `completionCriteria`
 * string array is human context: it is reported as not machine-checkable rather
 * than being reinterpreted into rules.
 *
 * For a read-only work type with no explicit workspace requirement, an implicit
 * `no-changes` check is applied — that is the one thing deterministically
 * expected of investigate/review/verify. An explicit workspace requirement
 * overrides the default rather than being added alongside it.
 *
 * implement/refactor/test get no default. Such a task may legitimately leave no
 * persistent change, and inferring otherwise would be inventing semantics.
 */
export function deriveRequirements(spec: {
	workType: WorkType;
	completionChecks?: readonly VerificationRequirement[];
	completionCriteria?: readonly string[];
}): { requirements: VerificationRequirement[]; notes: string[] } {
	const notes: string[] = [];
	const requirements: VerificationRequirement[] = [...(spec.completionChecks ?? [])];

	const hasExplicitWorkspaceCheck = requirements.some((r) =>
		WORKSPACE_KINDS.has((r as { kind?: string })?.kind ?? ""),
	);

	if (!hasExplicitWorkspaceCheck && isReadOnlyWorkType(spec.workType)) {
		requirements.unshift({
			id: "worktype-default:no-changes",
			kind: "no-changes",
		} as VerificationRequirement);
		notes.push(
			`Work type "${spec.workType}" is read-only: an implicit no-changes invariant was applied.`,
		);
	}

	if ((spec.completionChecks ?? []).length === 0) {
		notes.push(
			"No structured completionChecks were provided; free-form completionCriteria is human context and is not machine-checkable.",
		);
	}

	return { requirements, notes };
}

/** Duplicate-id detection: deterministic rejection. */
function duplicateIds(requirements: readonly { id: string }[]): string[] {
	const seen = new Set<string>();
	const dupes = new Set<string>();
	for (const r of requirements) {
		if (seen.has(r.id)) dupes.add(r.id);
		seen.add(r.id);
	}
	return [...dupes].sort();
}

function workerChangedPaths(evidence: WorkspaceEvidenceView): string[] {
	return evidence.changedFiles.map((f) => f.path).slice().sort();
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
	const sa = new Set(a);
	const sb = new Set(b);
	if (sa.size !== sb.size) return false;
	for (const item of sa) if (!sb.has(item)) return false;
	return true;
}

export interface VerifyOptions {
	requirements: readonly VerificationRequirement[];
	/** Step 7 evidence. Unavailable makes every workspace check unverifiable. */
	workspaceEvidence: WorkspaceEvidenceView | undefined;
	runner: CommandRunner;
	cwd: string;
	/** Bound on validation command execution. Never infinite. */
	commandTimeoutMs: number;
	maxOutputBytes?: number;
	/** Notes to carry into the result (e.g. from deriveRequirements). */
	notes?: readonly string[];
}

/**
 * Verify structured requirements against observed evidence.
 *
 * Never throws. A malformed requirement becomes an explicit `unverifiable` check
 * carrying the configuration problem, so a bad spec degrades to unknown instead
 * of crashing or falsely reporting success.
 */
export function verifyRequirements(options: VerifyOptions): VerificationEvidence {
	const checks: VerificationCheck[] = [];
	const validation: CommandVerification[] = [];

	const dupes = duplicateIds(options.requirements);
	if (dupes.length > 0) {
		checks.push({
			id: "config:duplicate-ids",
			kind: "config",
			state: "unverifiable",
			expected: "unique requirement ids",
			observed: dupes,
			reason: `Duplicate requirement ids: ${dupes.join(", ")}. Requirements must be uniquely identified.`,
		});
	}

	const evidenceAvailable = options.workspaceEvidence?.verificationStatus === "available";

	for (const requirement of options.requirements) {
		const id = requirement?.id ?? "(missing id)";
		const kind = (requirement as { kind?: string })?.kind ?? "(missing kind)";

		try {
			switch (kind) {
				case "changed-files": {
					const req = requirement as { paths: string[]; mode: "exact" | "includes" };
					checks.push(verifyChangedFiles(id, req, options, evidenceAvailable));
					break;
				}
				case "forbidden-files": {
					const req = requirement as { paths: string[] };
					checks.push(verifyForbiddenFiles(id, req, options, evidenceAvailable));
					break;
				}
				case "no-changes": {
					checks.push(verifyNoChanges(id, options, evidenceAvailable));
					break;
				}
				case "command":
				case "test": {
					const req = requirement as { argv: string[]; cwd?: string; timeoutMs?: number };
					const cmd = runCommandCheck(id, req, options);
					validation.push(cmd);
					checks.push({
						id,
						kind,
						state: cmd.state,
						expected: { exitCode: 0 },
						observed: { exitCode: cmd.exitCode, timedOut: cmd.timedOut },
						reason: cmd.reason,
					});
					break;
				}
				default:
					checks.push({
						id,
						kind,
						state: "unverifiable",
						reason: `Unknown requirement kind "${kind}". No deterministic check is defined for it.`,
					});
			}
		} catch (error) {
			// A malformed requirement is a configuration problem: not a Worker
			// failure, and certainly not a satisfied condition.
			checks.push({
				id,
				kind,
				state: "unverifiable",
				reason: `Malformed requirement: ${String(error)}`,
			});
		}
	}

	const states: VerificationState[] = [
		...checks.map((c) => c.state),
		...validation.map((v) => v.state),
	];

	return {
		state: aggregateStates(states),
		checks,
		validation,
		notes: [...(options.notes ?? [])],
	};
}

function unverifiableWithoutEvidence(id: string, kind: string): VerificationCheck {
	return {
		id,
		kind,
		state: "unverifiable",
		reason:
			"Workspace evidence is unavailable, so this workspace-dependent check cannot be established. " +
			"This is not a failure of the Worker.",
	};
}

function verifyChangedFiles(
	id: string,
	req: { paths: string[]; mode: "exact" | "includes" },
	options: VerifyOptions,
	evidenceAvailable: boolean,
): VerificationCheck {
	if (!evidenceAvailable) return unverifiableWithoutEvidence(id, "changed-files");
	const expected = [...(req.paths ?? [])].sort();
	const observed = workerChangedPaths(options.workspaceEvidence!);
	const mode = req.mode ?? "exact";

	if (mode === "includes") {
		const missing = expected.filter((p) => !observed.includes(p));
		return {
			id,
			kind: "changed-files",
			state: missing.length === 0 ? "satisfied" : "unsatisfied",
			expected: { mode, paths: expected },
			observed: { changedPaths: observed },
			reason:
				missing.length === 0
					? "All expected paths are present in the Worker-induced change set."
					: `Expected paths not changed: ${missing.join(", ")}`,
		};
	}

	const extra = observed.filter((p) => !expected.includes(p));
	const missing = expected.filter((p) => !observed.includes(p));
	const ok = sameSet(expected, observed);
	return {
		id,
		kind: "changed-files",
		state: ok ? "satisfied" : "unsatisfied",
		expected: { mode, paths: expected },
		observed: { changedPaths: observed },
		reason: ok
			? "Worker-induced change set matches the expected set exactly."
			: `Expected set does not match. Missing: [${missing.join(", ")}] Unexpected: [${extra.join(", ")}]`,
	};
}

function verifyForbiddenFiles(
	id: string,
	req: { paths: string[] },
	options: VerifyOptions,
	evidenceAvailable: boolean,
): VerificationCheck {
	if (!evidenceAvailable) return unverifiableWithoutEvidence(id, "forbidden-files");
	const forbidden = [...(req.paths ?? [])].sort();
	const observed = workerChangedPaths(options.workspaceEvidence!);
	const hit = observed.filter((p) => forbidden.includes(p));
	return {
		id,
		kind: "forbidden-files",
		state: hit.length === 0 ? "satisfied" : "unsatisfied",
		expected: { forbiddenPaths: forbidden },
		observed: { changedPaths: observed, forbiddenPathsChanged: hit },
		reason:
			hit.length === 0
				? "No forbidden path appears in the Worker-induced change set."
				: `Forbidden paths were changed: ${hit.join(", ")}`,
	};
}

function verifyNoChanges(
	id: string,
	options: VerifyOptions,
	evidenceAvailable: boolean,
): VerificationCheck {
	if (!evidenceAvailable) return unverifiableWithoutEvidence(id, "no-changes");
	const observed = workerChangedPaths(options.workspaceEvidence!);
	return {
		id,
		kind: "no-changes",
		state: observed.length === 0 ? "satisfied" : "unsatisfied",
		expected: { workerChangedFileCount: 0 },
		observed: { workerChangedFileCount: observed.length, changedPaths: observed },
		reason:
			observed.length === 0
				? "The Worker induced no workspace changes (pre-existing dirt is not counted)."
				: `The Worker changed ${observed.length} path(s): ${observed.join(", ")}`,
	};
}

function runCommandCheck(
	id: string,
	req: { argv: string[]; cwd?: string; timeoutMs?: number },
	options: VerifyOptions,
): CommandVerification {
	const argv = req.argv ?? [];
	const base: CommandVerification = {
		commandId: id,
		argv: [...argv],
		exitCode: null,
		timedOut: false,
		state: "unverifiable",
	};

	if (!Array.isArray(argv) || argv.length === 0 || argv[0] === "") {
		return {
			...base,
			reason: "No executable in argv. The command could not be run, so nothing is established.",
		};
	}

	const maxOut = options.maxOutputBytes ?? DEFAULT_MAX_COMMAND_OUTPUT_BYTES;
	const timeoutMs = req.timeoutMs ?? options.commandTimeoutMs;
	const result = options.runner.run(argv, {
		cwd: req.cwd ?? options.cwd,
		timeoutMs,
	});

	const stdout = truncate(result.stdout, maxOut);
	const stderr = truncate(result.stderr, maxOut);

	// The truncation facts travel with the text on every return path below, so a
	// reader can always tell a short stream from a cut one.
	const output = {
		stdout: stdout.text,
		stderr: stderr.text,
		stdoutTruncated: stdout.truncated,
		stderrTruncated: stderr.truncated,
		outputByteLimit: maxOut,
	};

	if (result.timedOut) {
		return {
			...base,
			...output,
			timedOut: true,
			state: "unverifiable",
			reason: `Command timed out after ${timeoutMs}ms. No exit code was observed.`,
		};
	}

	if (!result.started) {
		return {
			...base,
			...output,
			state: "unverifiable",
			reason: `Command could not be executed: ${stderr.text || "unknown reason"}`,
		};
	}

	const exitCode = result.exitCode;
	if (exitCode === null) {
		return {
			...base,
			...output,
			state: "unverifiable",
			reason: "Command produced no exit code.",
		};
	}

	return {
		...base,
		...output,
		exitCode,
		state: exitCode === 0 ? "satisfied" : "unsatisfied",
		reason:
			exitCode === 0
				? "Command exited 0."
				: `Command exited ${exitCode}. This is a verification outcome, not a Worker execution error.`,
	};
}

function truncate(text: string, maxBytes: number): { text: string; truncated: boolean } {
	const value = text ?? "";
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return { text: value, truncated: false };
	return { text: value.slice(0, maxBytes), truncated: true };
}
