import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Raised when a Git observation cannot be performed at all.
 *
 * Callers must translate this into `verificationStatus: "unavailable"`. It must
 * never be silently converted into "no changes".
 */
export class GitObservationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GitObservationError";
	}
}

export interface GitRunResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	code: number;
}

/**
 * Injectable Git CLI seam.
 *
 * Everything Git-related goes through this, so tests can drive the observer with
 * canned porcelain/numstat output instead of a real repository.
 */
export interface GitRunner {
	run(args: readonly string[], cwd: string): GitRunResult;
}

export const systemGitRunner: GitRunner = {
	run(args, cwd) {
		try {
			const stdout = execFileSync("git", [...args], {
				cwd,
				encoding: "utf8",
				maxBuffer: 64 * 1024 * 1024,
				stdio: ["ignore", "pipe", "pipe"],
			});
			return { ok: true, stdout, stderr: "", code: 0 };
		} catch (error) {
			const e = error as { status?: number; stdout?: string; stderr?: string };
			return {
				ok: false,
				stdout: e.stdout ?? "",
				stderr: e.stderr ?? String(error),
				code: e.status ?? -1,
			};
		}
	},
};

/**
 * How a file's identity was established in a snapshot.
 *
 * `index-blob`  : tracked and worktree-clean; identity is the index blob oid.
 *                 No file read required.
 * `content-hash`: worktree bytes hashed to a Git blob oid (see `gitBlobOid`).
 *                 Used for dirty tracked files and for untracked files under
 *                 the size cap. Comparable to an `index-blob` oid.
 * `size-only`   : file exceeded the hash size cap; identity is the byte size.
 *                 Weaker — a same-size rewrite is not detected. Reported as a
 *                 limitation rather than silently trusted.
 * `absent`      : the path does not exist in the worktree.
 */
export type FileIdentityKind = "index-blob" | "content-hash" | "size-only" | "absent";

/**
 * Computes a Git blob object id for arbitrary bytes: sha1 of
 * `blob <byteLength>\0<bytes>`.
 *
 * This is the same identity Git stores in the index, which is what makes a
 * locally-hashed worktree file directly comparable to an index blob oid.
 * Comparing Git's own object ids is what avoids the false-negative trap of
 * comparing byte sizes: a same-size edit is still a different blob.
 *
 * sha1 here is Git's content-identity scheme, not a security primitive.
 */
export function gitBlobOid(bytes: Buffer | string): string {
	const buf = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes;
	return createHash("sha1")
		.update(`blob ${buf.length}\u0000`)
		.update(buf)
		.digest("hex");
}

/**
 * The oid that identifies this identity's bytes in Git terms, when one is known.
 * `content-hash` identities carry a locally computed git blob oid; clean tracked
 * files carry the index blob. Both are directly comparable.
 */
export function comparableOid(identity: FileIdentity): string | undefined {
	return identity.contentHash ?? identity.indexBlob;
}

export interface FileIdentity {
	path: string;
	exists: boolean;
	tracked: boolean;
	untracked: boolean;
	identity: FileIdentityKind;
	indexBlob?: string;
	contentHash?: string;
	size?: number;
	/** Raw porcelain v1 XY status, when the path appeared in `git status`. */
	status?: string;
	/**
	 * For a staged rename/copy, the origin path Git reported in the extra NUL
	 * field. Recorded so the comparison can pair the two paths instead of
	 * reporting an unrelated delete + add pair.
	 */
	renameOrigin?: string;
	/** X field is not blank/untracked -> something is staged for this path. */
	staged: boolean;
	/** Present in the git index. */
	inIndex: boolean;
}

/** A parsed `git status` entry. */
export interface StatusEntry {
	xy: string;
	/** Extra origin field, present only for R/C entries. */
	origin?: string;
}

export interface GitSnapshot {
	capturedAt: number;
	/** HEAD commit oid, or null for an unborn HEAD (repo with no commits). */
	head: string | null;
	branch: string | null;
	files: ReadonlyMap<string, FileIdentity>;
}

export interface GitObserverOptions {
	cwd: string;
	runner?: GitRunner;
	/**
	 * Files larger than this are not hashed; identity falls back to byte size.
	 * Keeps evidence collection from reading huge untracked artifacts.
	 */
	maxHashBytes?: number;
	/** Injectable clock. */
	now?: () => number;
}

export const DEFAULT_MAX_HASH_BYTES = 2 * 1024 * 1024;

/**
 * Captures a deterministic, Git-visible snapshot of a workspace.
 *
 * Deliberately does NOT use plain `git diff`: that misses untracked files,
 * cannot represent pre-existing dirt, and cannot answer "what changed since an
 * arbitrary earlier workspace state". Instead the observer records the identity
 * of every Git-visible path, and change detection is a comparison of two
 * snapshots.
 *
 * Git-visible means: tracked files (index/HEAD) plus untracked files reported by
 * `--untracked-files=all`. Ignored files are NOT observed (documented policy).
 */
export class GitObserver {
	private readonly cwd: string;
	private readonly runner: GitRunner;
	private readonly maxHashBytes: number;
	private readonly now: () => number;

	public constructor(options: GitObserverOptions) {
		this.cwd = options.cwd;
		this.runner = options.runner ?? systemGitRunner;
		this.maxHashBytes = options.maxHashBytes ?? DEFAULT_MAX_HASH_BYTES;
		this.now = options.now ?? (() => Date.now());
	}

	/** True when `cwd` is inside a Git work tree. */
	public isWorkTree(): boolean {
		const result = this.runner.run(["rev-parse", "--is-inside-work-tree"], this.cwd);
		return result.ok && result.stdout.trim() === "true";
	}

	public capture(): GitSnapshot {
		const cwd = this.cwd;

		const inside = this.runner.run(["rev-parse", "--is-inside-work-tree"], cwd);
		if (!inside.ok || inside.stdout.trim() !== "true") {
			throw new GitObservationError(
				`not a git work tree: ${firstLine(inside.stderr) || cwd}`,
			);
		}

		const headResult = this.runner.run(["rev-parse", "HEAD"], cwd);
		// An unborn HEAD is a valid baseline, not a failure.
		const head = headResult.ok ? headResult.stdout.trim() || null : null;

		const branchResult = this.runner.run(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
		const branch = branchResult.ok ? branchResult.stdout.trim() || null : null;

		const indexEntries = this.readIndex(cwd);
		const statusEntries = this.readStatus(cwd);

		const paths = new Set<string>([...indexEntries.keys(), ...statusEntries.keys()]);
		const files = new Map<string, FileIdentity>();

		for (const path of [...paths].sort()) {
			files.set(path, this.identify(cwd, path, indexEntries.get(path), statusEntries.get(path)));
		}

		return { capturedAt: this.now(), head, branch, files };
	}

	/** `git ls-files -s -z` -> path -> index blob oid. */
	private readIndex(cwd: string): Map<string, string> {
		const result = this.runner.run(["ls-files", "-s", "-z"], cwd);
		if (!result.ok) {
			throw new GitObservationError(`git ls-files failed: ${firstLine(result.stderr)}`);
		}
		const map = new Map<string, string>();
		for (const field of splitNul(result.stdout)) {
			// "<mode> <oid>\t<path>"
			const tab = field.indexOf("\t");
			if (tab === -1) continue;
			const meta = field.slice(0, tab);
			const path = field.slice(tab + 1);
			const oid = meta.split(" ")[1];
			if (path && oid) map.set(path, oid);
		}
		return map;
	}

	/**
	 * `git status --porcelain=v1 -z -uall` -> path -> XY status.
	 *
	 * Rename/copy entries emit the current path followed by an EXTRA NUL field
	 * holding the origin path, so the field stream is not uniformly 1-per-entry.
	 */
	private readStatus(cwd: string): Map<string, StatusEntry> {
		const result = this.runner.run(
			["status", "--porcelain=v1", "-z", "--untracked-files=all"],
			cwd,
		);
		if (!result.ok) {
			throw new GitObservationError(`git status failed: ${firstLine(result.stderr)}`);
		}
		const fields = splitNul(result.stdout);
		const map = new Map<string, StatusEntry>();
		let i = 0;
		while (i < fields.length) {
			const field = fields[i]!;
			const xy = field.slice(0, 2);
			const path = field.slice(3);
			if (xy.includes("R") || xy.includes("C")) {
				// Git emits the origin path as a SEPARATE NUL field. It must be
				// consumed here, or the next entry is misread as a status line.
				map.set(path, { xy, origin: fields[i + 1] });
				i += 2;
			} else {
				map.set(path, { xy });
				i += 1;
			}
		}
		return map;
	}

	private identify(
		cwd: string,
		path: string,
		indexBlob: string | undefined,
		entry: StatusEntry | undefined,
	): FileIdentity {
		const status = entry?.xy;
		const x = status ? status[0]! : " ";
		const y = status ? status[1]! : " ";
		const untracked = x === "?" && y === "?";
		const ignored = x === "!" || y === "!";
		const inIndex = indexBlob !== undefined;
		const tracked = inIndex && !untracked;
		const staged = !untracked && x !== " " && x !== undefined;

		const base: FileIdentity = {
			path,
			exists: false,
			tracked,
			untracked,
			identity: "absent",
			status,
			...(entry?.origin !== undefined ? { renameOrigin: entry.origin } : {}),
			staged,
			inIndex,
		};

		if (ignored) {
			// Ignored files are outside the observation boundary.
			return { ...base, tracked: false, untracked: false, staged: false };
		}

		// Deleted in the worktree (unstaged delete ` D`, or staged delete `D `).
		if (y === "D" || x === "D") {
			return { ...base, exists: false, identity: "absent" };
		}

		let stat: { size: number };
		try {
			stat = statSync(join(cwd, path));
		} catch {
			return { ...base, exists: false, identity: "absent" };
		}

		// Tracked and worktree-clean: the index blob is authoritative, no read.
		if (tracked && y === " " && indexBlob !== undefined) {
			return {
				...base,
				exists: true,
				identity: "index-blob",
				indexBlob,
				size: stat.size,
			};
		}

		// Dirty tracked file or untracked file: hash the worktree bytes, capped.
		if (stat.size > this.maxHashBytes) {
			return { ...base, exists: true, identity: "size-only", size: stat.size };
		}

		try {
			const bytes = readFileSync(join(cwd, path));
			return {
				...base,
				exists: true,
				identity: "content-hash",
				contentHash: gitBlobOid(bytes),
				size: bytes.length,
			};
		} catch {
			return { ...base, exists: true, identity: "size-only", size: stat.size };
		}
	}
}

export function splitNul(text: string): string[] {
	if (text === "") return [];
	const parts = text.split("\0");
	// A trailing NUL produces a final empty field; drop only that.
	if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
	return parts;
}

function firstLine(text: string): string {
	return (text ?? "").split("\n")[0]?.trim() ?? "";
}
