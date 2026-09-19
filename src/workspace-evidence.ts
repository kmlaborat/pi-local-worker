import {
	comparableOid,
	GitObservationError,
	GitObserver,
	type FileIdentity,
	type GitRunner,
	type GitSnapshot,
	splitNul,
	systemGitRunner,
} from "./git-observer.ts";

/**
 * Git status vocabulary, restricted to what Step 7 can actually observe.
 *
 * `R`/`C` are reported only when Git itself reported them (a staged rename/copy).
 * An *unstaged* rename is observed as `D` + `A`, because that is what Git
 * reports before the pair is staged together. Step 7 does not invent rename
 * detection.
 */
export type ChangedFileStatus = "A" | "M" | "D" | "R" | "C";

export interface ChangedFile {
	path: string;
	status: ChangedFileStatus;
	/** Origin path for R/C, as reported by Git. */
	oldPath?: string;
	/** True when the change is present in the git index (staged). */
	staged: boolean;
	/** True when the path was already dirty at baseline and is still Worker-touched. */
	includesPreExistingChanges: boolean;
	/** True when a textual diff for this path is available in `patch`. */
	patchAvailable: boolean;
	/** True when the path was untracked at baseline. */
	untrackedAtBaseline: boolean;
	/** True when the path is untracked in the final workspace. */
	untrackedNow: boolean;
	sizeBefore?: number;
	sizeAfter?: number;
	/**
	 * Git blob object ids (sha1, `blob <len>\0<bytes>`) before and after.
	 * Present only where the bytes were hashed, i.e. not for `size-only`
	 * over-cap files. Absent on the side where the file did not exist.
	 */
	contentHashBefore?: string;
	contentHashAfter?: string;
}

export interface DiffStatEntry {
	path: string;
	/** Lines added; null means Git reported `-` (binary). */
	added: number | null;
	deleted: number | null;
	binary: boolean;
}

export interface PatchEvidence {
	text: string;
	truncated: boolean;
	totalBytes: number;
	byteLimit: number;
	/** What the patch is measured against. */
	reference: "HEAD";
}

export interface GitBaselineSummary {
	capturedAt: number;
	head: string | null;
	branch: string | null;
	/** Paths that were already dirty (tracked, differing from HEAD/index) at baseline. */
	preExistingDirtyPaths: readonly string[];
	/** Paths that were already untracked at baseline. */
	preExistingUntrackedPaths: readonly string[];
	/** True when the repository had no commits at baseline. */
	unbornHead: boolean;
	/** True when the dirty/untracked lists were truncated. */
	listTruncated: boolean;
}

/**
 * Deterministic workspace-change evidence.
 *
 * Observation only. This structure deliberately has no field that expresses a
 * verdict — no `correct`, `passed`, `complete`, `violated`. Deciding whether the
 * Worker did the right thing belongs to a later Gate layer.
 */
export interface WorkspaceEvidence {
	verificationStatus: "available" | "unavailable";
	capturedAt: number;
	baseline?: GitBaselineSummary;
	/** Files whose Git-visible identity differs between baseline and final. */
	changedFiles: readonly ChangedFile[];
	/** All tracked changes vs HEAD (includes pre-existing dirt). */
	diffStat: readonly DiffStatEntry[];
	/** diffStat restricted to Worker-changed paths. */
	workerDiffStat: readonly DiffStatEntry[];
	patch?: PatchEvidence;
	/** Machine-readable failure reasons. Non-empty only when unavailable. */
	errors: readonly string[];
	/** Machine-readable caveats about what the evidence can and cannot show. */
	limitations: readonly string[];
}

export interface CollectWorkspaceEvidenceOptions {
	cwd: string;
	/** Baseline snapshot captured before Worker execution. */
	baseline: GitSnapshot | undefined;
	/** Baseline capture error, if the baseline itself failed. */
	baselineError?: string;
	runner?: GitRunner;
	maxHashBytes?: number;
	/** Cap on the retained patch text. */
	maxPatchBytes?: number;
	/** Cap on the number of pre-existing dirty/untracked paths listed. */
	maxListedPaths?: number;
	now?: () => number;
}

export const DEFAULT_MAX_PATCH_BYTES = 256 * 1024;
export const DEFAULT_MAX_LISTED_PATHS = 200;

/**
 * Compare two snapshots and produce Worker-induced change evidence.
 *
 * The comparison is by path and content identity, never by "is the tree dirty".
 * That is what makes a pre-existing dirty workspace produce an empty Worker
 * change set.
 */
export function compareSnapshots(
	baseline: GitSnapshot,
	final: GitSnapshot,
): ChangedFile[] {
	const paths = new Set<string>([...baseline.files.keys(), ...final.files.keys()]);
	const changed: ChangedFile[] = [];

	// A staged rename removes the origin path from the worktree, so it would
	// otherwise surface as an unrelated `D` alongside the `R`. Collect the origins
	// Git already paired so the rename is reported once, as `R old -> new`.
	const renamedOrigins = new Set<string>();
	for (const identity of final.files.values()) {
		if (identity.renameOrigin && (identity.status?.startsWith("R") ?? false)) {
			renamedOrigins.add(identity.renameOrigin);
		}
	}

	for (const path of [...paths].sort()) {
		const before = baseline.files.get(path);
		const after = final.files.get(path);

		if (!before && after && after.exists) {
			const st = after.status ?? "";
			if (st.startsWith("R")) {
				const entry = baseChange(path, "R", after, before);
				if (after.renameOrigin) entry.oldPath = after.renameOrigin;
				changed.push(entry);
			} else if (st.startsWith("C")) {
				const entry = baseChange(path, "C", after, before);
				if (after.renameOrigin) entry.oldPath = after.renameOrigin;
				changed.push(entry);
			} else {
				changed.push(baseChange(path, "A", after, before));
			}
			continue;
		}
		if (before && before.exists && (!after || !after.exists)) {
			// Covered by a paired rename on the final side; do not double-report.
			if (renamedOrigins.has(path)) continue;
			// Use a synthetic absent identity so the evidence never claims an
			// "after" size or hash for a file that no longer exists.
			changed.push(baseChange(path, "D", ABSENT_IDENTITY, before));
			continue;
		}
		if (!before || !after) continue;
		if (!before.exists && !after.exists) continue;

		if (identityEquals(before, after)) continue;

		// Git reported a staged rename/copy on the final side: honour it rather
		// than reporting an unrelated M.
		const status = after.status ?? "";
		if (status.startsWith("R") || status.startsWith("C")) {
			const entry = baseChange(path, status[0] === "R" ? "R" : "C", after, before);
			if (after.renameOrigin) entry.oldPath = after.renameOrigin;
			changed.push(entry);
			continue;
		}
		changed.push(baseChange(path, "M", after, before));
	}

	return changed;
}

/** Stand-in for a path that does not exist in the worktree. */
const ABSENT_IDENTITY: FileIdentity = {
	path: "",
	exists: false,
	tracked: false,
	untracked: false,
	identity: "absent",
	staged: false,
	inIndex: false,
};

function baseChange(
	path: string,
	status: ChangedFileStatus,
	after: FileIdentity,
	before: FileIdentity | undefined,
): ChangedFile {
	const entry: ChangedFile = {
		path,
		status,
		staged: after.staged === true,
		includesPreExistingChanges: before?.exists === true && wasDirty(before),
		// A newly added untracked file has no textual diff; presence + hash is the evidence.
		patchAvailable: !(status === "A" && after.untracked === true),
		untrackedAtBaseline: before?.untracked === true,
		untrackedNow: after.untracked === true,
	};
	if (before?.size !== undefined) entry.sizeBefore = before.size;
	if (after.size !== undefined) entry.sizeAfter = after.size;
	if (before?.contentHash) entry.contentHashBefore = before.contentHash;
	if (after.contentHash) entry.contentHashAfter = after.contentHash;
	return entry;
}

/**
 * True when Git reported this tracked path as differing from HEAD/index.
 *
 * A tracked file with NO `git status` entry is clean: `git status` only lists
 * paths that differ. Treating a missing entry as "not dirty" is what keeps a
 * clean baseline from looking like a workspace full of pre-existing changes.
 */
function wasDirty(identity: { tracked: boolean; status?: string }): boolean {
	if (!identity.tracked) return false;
	const xy = identity.status;
	// No status entry at all => Git considers the path unmodified.
	if (xy === undefined || xy === "") return false;
	return xy[0] !== " " || xy[1] !== " ";
}

/**
 * Identity equality.
 *
 * Two identities are equal when they describe the same bytes.
 *
 * Where either side carries a Git-comparable oid (a locally computed blob oid or
 * an index blob), the oids decide. Because `content-hash` identities use
 * `gitBlobOid`, a worktree file and its index entry are compared with the same
 * scheme, so:
 *
 *   clean baseline -> same content staged   => equal  (no change)
 *   clean baseline -> same-size edit        => unequal (change)
 *
 * Byte size is used only when no oid is available on a side, i.e. the
 * `size-only` cap. That weakness is surfaced in the evidence limitations.
 */
function identityEquals(a: FileIdentity, b: FileIdentity): boolean {
	const oa = comparableOid(a);
	const ob = comparableOid(b);
	if (oa !== undefined && ob !== undefined) return oa === ob;
	// At least one side is `size-only`: no stronger comparison exists.
	return a.size === b.size;
}

/**
 * Summarize the workspace state as it stood at baseline.
 *
 * Splits the snapshot's paths into those that were already dirty (tracked and
 * differing from HEAD/index) and those that were already untracked, so the final
 * comparison can tell Worker-induced changes apart from pre-existing ones. The
 * listed paths are capped, with overflow reported by `listTruncated`.
 */
function summarizeBaseline(
	baseline: GitSnapshot,
	maxListedPaths: number,
): GitBaselineSummary {
	const dirty: string[] = [];
	const untracked: string[] = [];
	for (const [path, identity] of baseline.files) {
		if (identity.untracked) untracked.push(path);
		else if (wasDirty(identity)) dirty.push(path);
	}
	dirty.sort();
	untracked.sort();
	return {
		capturedAt: baseline.capturedAt,
		head: baseline.head,
		branch: baseline.branch,
		preExistingDirtyPaths: dirty.slice(0, maxListedPaths),
		preExistingUntrackedPaths: untracked.slice(0, maxListedPaths),
		unbornHead: baseline.head === null,
		listTruncated: dirty.length > maxListedPaths || untracked.length > maxListedPaths,
	};
}

function parseNumstat(stdout: string): DiffStatEntry[] {
	const entries: DiffStatEntry[] = [];
	for (const field of splitNul(stdout)) {
		const parts = field.split("\t");
		if (parts.length < 3) continue;
		const [added, deleted, ...rest] = parts;
		const path = rest.join("\t");
		const binary = added === "-" || deleted === "-";
		entries.push({
			path,
			added: binary ? null : Number(added),
			deleted: binary ? null : Number(deleted),
			binary,
		});
	}
	return entries;
}

/**
 * Collect the final workspace observation and assemble the evidence.
 *
 * Never throws. Failures become `verificationStatus: "unavailable"` with
 * structured errors, leaving the Worker result itself untouched.
 */
export function collectWorkspaceEvidence(
	options: CollectWorkspaceEvidenceOptions,
): WorkspaceEvidence {
	const now = options.now ?? (() => Date.now());
	const maxPatchBytes = options.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES;
	const maxListedPaths = options.maxListedPaths ?? DEFAULT_MAX_LISTED_PATHS;
	const capturedAt = now();

	const unavailable = (errors: string[], baseline?: GitBaselineSummary): WorkspaceEvidence => ({
		verificationStatus: "unavailable",
		capturedAt,
		...(baseline ? { baseline } : {}),
		changedFiles: [],
		diffStat: [],
		workerDiffStat: [],
		errors,
		limitations: [
			"Git observation failed; changedFiles is empty because nothing was observed, not because nothing changed.",
		],
	});

	if (!options.baseline) {
		return unavailable([
			`baseline capture failed: ${options.baselineError ?? "no baseline available"}`,
		]);
	}

	const baselineSummary = summarizeBaseline(options.baseline, maxListedPaths);
	const observer = new GitObserver({
		cwd: options.cwd,
		runner: options.runner,
		maxHashBytes: options.maxHashBytes,
		now,
	});

	let finalSnapshot: GitSnapshot;
	try {
		finalSnapshot = observer.capture();
	} catch (error) {
		const message =
			error instanceof GitObservationError
				? error.message
				: `final git observation failed: ${String(error)}`;
		// §21: baseline stays available, the final observation is reported failed.
		return unavailable([`baseline captured but final observation failed: ${message}`], baselineSummary);
	}

	const changedFiles = compareSnapshots(options.baseline, finalSnapshot);
	const limitations: string[] = [];

	// Tracked-change stat, measured against HEAD.
	let diffStat: DiffStatEntry[] = [];
	let patch: PatchEvidence | undefined;
	try {
		const statResult = (options.runner ?? systemGitRunner).run(
			["diff", "HEAD", "--numstat", "-z"],
			options.cwd,
		);
		if (statResult.ok) {
			diffStat = parseNumstat(statResult.stdout);
		} else if (finalSnapshot.head === null) {
			// Unborn HEAD: nothing to diff against.
			limitations.push(
				"Repository has no commits; tracked diff evidence is unavailable against an unborn HEAD.",
			);
		} else {
			limitations.push(
				`git diff --numstat failed: ${statResult.stderr.split("\n")[0]?.trim() ?? "unknown"}`,
			);
		}

		const patchResult = (options.runner ?? systemGitRunner).run(
			["diff", "HEAD", "--no-color"],
			options.cwd,
		);
		if (patchResult.ok) {
			const totalBytes = Buffer.byteLength(patchResult.stdout, "utf8");
			patch = {
				text:
					totalBytes > maxPatchBytes
						? patchResult.stdout.slice(0, maxPatchBytes)
						: patchResult.stdout,
				truncated: totalBytes > maxPatchBytes,
				totalBytes,
				byteLimit: maxPatchBytes,
				reference: "HEAD",
			};
		}
	} catch (error) {
		limitations.push(`diff evidence unavailable: ${String(error)}`);
	}

	const workerPaths = new Set(changedFiles.map((f) => f.path));
	const workerDiffStat = diffStat.filter((entry) => workerPaths.has(entry.path));

	if (changedFiles.some((f) => f.includesPreExistingChanges)) {
		limitations.push(
			"Some Worker-changed paths were already dirty at baseline; their diff against HEAD includes pre-existing changes.",
		);
	}
	if (changedFiles.some((f) => f.untrackedNow || f.untrackedAtBaseline)) {
		limitations.push(
			"Untracked files are evidenced by presence, size and content hash only; no textual diff exists for them.",
		);
	}
	if (
		[...options.baseline.files.values(), ...finalSnapshot.files.values()].some(
			(f) => f.identity === "size-only",
		)
	) {
		limitations.push(
			"One or more files exceeded the hash size cap and were compared by byte size only; a same-size rewrite of such a file is not detected.",
		);
	}
	limitations.push(
		"Ignored files (per .gitignore) are outside the observation boundary and are never reported as Worker changes.",
	);
	limitations.push(
		"patch and diffStat are measured against HEAD and may include pre-existing workspace changes.",
	);

	return {
		verificationStatus: "available",
		capturedAt,
		baseline: baselineSummary,
		changedFiles,
		diffStat,
		workerDiffStat,
		...(patch ? { patch } : {}),
		errors: [],
		limitations,
	};
}

