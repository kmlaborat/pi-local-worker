import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterAll, expect } from "vitest";

/**
 * Every fake-git directory created in the current test file.
 *
 * Harness/tool tests build fake workspaces inside a factory and have no natural
 * place for a per-test `finally`, so the registry plus the `afterAll` below
 * guarantees the directories are removed without each test having to remember.
 */
const createdDirs: string[] = [];

afterAll(() => {
	for (const dir of createdDirs.splice(0)) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* best-effort */
		}
	}
});

import type { GitRunner, GitRunResult } from "../../src/git-observer.ts";

/**
 * A declared workspace file, described the way Git would describe it.
 *
 * The point of this fake is that tests declare Git's *output* directly instead of
 * driving a real repository. Git semantics are the risky part of Step 7; real file
 * I/O is not, so worktree contents are still written to disk (the observer hashes
 * them) while every Git command answer is canned.
 */
export interface FakeFile {
	path: string;
	/**
	 * Porcelain v1 XY status, exactly two characters, e.g. `" M"`, `"M "`,
	 * `"??"`, `"D "`, `" D"`, `"R "`.
	 */
	status: string;
	/** Index blob oid. Present => the path is in the index. */
	indexBlob?: string;
	/** Worktree content. Omit => the path does not exist in the worktree. */
	content?: string;
	/** Origin path for a staged rename/copy (XY contains R or C). */
	origin?: string;
	/** Lines added/deleted reported by `diff HEAD --numstat`. `"-"` => binary. */
	added?: number | "-";
	deleted?: number | "-";
}

export interface FakeGitOptions {
	head?: string | null;
	branch?: string | null;
	files?: FakeFile[];
	/** Canned `git diff HEAD --no-color` output. */
	patch?: string;
	/** Force a command to fail with this stderr. */
	fail?: {
		insideWorkTree?: string;
		revParseHead?: string;
		abbrevRef?: string;
		lsFiles?: string;
		status?: string;
		diffNumstat?: string;
		diffPatch?: string;
	};
}

export interface FakeGit {
	readonly dir: string;
	readonly runner: GitRunner;
	/** Replace the whole declared workspace state. */
	setFiles(files: FakeFile[]): void;
	setHead(head: string | null): void;
	setFail(fail: FakeGitOptions["fail"]): void;
	setPatch(patch: string): void;
	/** Commands the runner was asked to run, for leak/coverage assertions. */
	readonly calls: string[][];
	/**
	 * Resolve once a command matching `predicate` has been issued.
	 *
	 * Lets a test wait for the baseline capture to complete before mutating the
	 * workspace, so "Worker-induced" changes are never racing the baseline.
	 */
	waitForCall(predicate: (args: readonly string[]) => boolean, timeoutMs?: number): Promise<void>;
	/** Number of calls matching `predicate` currently recorded. */
	countCalls(predicate: (args: readonly string[]) => boolean): number;
	cleanup(): void;
}

let counter = 0;

/**
 * Build a fake Git runner over a real temporary directory.
 *
 * Worktree files really exist on disk so content hashing behaves normally. Every
 * Git command response is produced from the declared state, so parsing behaviour
 * is deterministic and independent of the machine's Git version.
 */
export function createFakeGit(options: FakeGitOptions = {}): FakeGit {
	const dir = join(
		process.env.TEMP || process.env.TMP || "/tmp",
		`pilw-fakegit-${process.pid}-${counter++}`,
	);
	mkdirSync(dir, { recursive: true });
	createdDirs.push(dir);

	let head = options.head === undefined ? "0".repeat(40) : options.head;
	let branch = options.branch === undefined ? "master" : options.branch;
	let files = options.files ?? [];
	let patch = options.patch ?? "";
	let fail = options.fail ?? {};
	const calls: string[][] = [];

	function materialize(): void {
		for (const file of files) {
			if (file.content === undefined) continue;
			const target = join(dir, file.path);
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, file.content, "utf8");
		}
	}
	materialize();

	function ok(stdout: string): GitRunResult {
		return { ok: true, stdout, stderr: "", code: 0 };
	}
	function err(stderr: string): GitRunResult {
		return { ok: false, stdout: "", stderr, code: 128 };
	}

	type FakeKey = keyof NonNullable<FakeGitOptions["fail"]>;

	function keyFor(args: readonly string[]): FakeKey | null {
		const joined = args.join(" ");
		if (joined.includes("--is-inside-work-tree")) return "insideWorkTree";
		if (joined === "rev-parse HEAD") return "revParseHead";
		if (joined.includes("--abbrev-ref")) return "abbrevRef";
		if (joined.startsWith("ls-files")) return "lsFiles";
		if (joined.startsWith("status")) return "status";
		if (joined.includes("--numstat")) return "diffNumstat";
		if (joined.includes("--no-color")) return "diffPatch";
		return null;
	}

	const runner: GitRunner = {
		run(args, cwd): GitRunResult {
			calls.push([...args]);
			const key = keyFor(args);

			if (key && fail[key]) {
				return err(fail[key]!);
			}

			switch (key) {
				case "insideWorkTree":
					return ok("true\n");

				case "revParseHead":
					if (head === null) {
						return err(
							"fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.",
						);
					}
					return ok(`${head}\n`);

				case "abbrevRef":
					if (head === null) return err("fatal: ambiguous argument 'HEAD'");
					return ok(`${branch ?? "HEAD"}\n`);

				case "lsFiles": {
					const body = files
						.filter((f) => f.indexBlob !== undefined)
						.map((f) => `100644 ${f.indexBlob}\t${f.path}`)
						.join("\0");
					return ok(body === "" ? "" : `${body}\0`);
				}

				case "status": {
					const parts: string[] = [];
					for (const f of files) {
						// Git reports NOTHING for an unmodified tracked file. A
						// declared "  " entry means "clean, not reported".
						if (f.status === "  " || f.status === "") continue;
						parts.push(`${f.status} ${f.path}`);
						// Git emits the origin path as an EXTRA NUL field for R/C.
						if (f.status.includes("R") || f.status.includes("C")) {
							parts.push(f.origin ?? `${f.path}.origin`);
						}
					}
					return ok(parts.length === 0 ? "" : `${parts.join("\0")}\0`);
				}

				case "diffNumstat": {
					const parts = files
						.filter((f) => f.added !== undefined || f.deleted !== undefined)
						.map(
							(f) =>
								`${f.added ?? "0"}\t${f.deleted ?? "0"}\t${f.path}`,
						);
					return ok(parts.length === 0 ? "" : `${parts.join("\0")}\0`);
				}

				case "diffPatch":
					return ok(patch);

				default:
					return err(`fake git: unhandled command: ${args.join(" ")} (cwd ${cwd})`);
			}
		},
	};

	return {
		dir,
		runner,
		setFiles(next: FakeFile[]) {
			files = next;
			materialize();
		},
		setHead(next: string | null) {
			head = next;
		},
		setFail(next: FakeGitOptions["fail"]) {
			fail = next ?? {};
		},
		setPatch(next: string) {
			patch = next;
		},
		calls,
		countCalls(predicate) {
			return calls.filter((c) => predicate(c)).length;
		},
		waitForCall(predicate, timeoutMs = 2000) {
			return new Promise<void>((resolve, reject) => {
				const started = Date.now();
				const tick = () => {
					if (calls.some((c) => predicate(c))) {
						resolve();
						return;
					}
					if (Date.now() - started > timeoutMs) {
						reject(new Error(`timed out waiting for git call: ${JSON.stringify(calls)}`));
						return;
					}
					setTimeout(tick, 1);
				};
				tick();
			});
		},
		cleanup() {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				/* best-effort */
			}
		},
	};
}

/**
 * Expected evidence matcher for a run that changed nothing.
 *
 * Exported so harness/tool tests can assert the new field is present without
 * hard-coding the limitation prose, which is documentation and may be reworded.
 */
export function unchangedEvidence() {
	return expect.objectContaining({
		verificationStatus: "available",
		changedFiles: [],
		workerDiffStat: [],
		errors: [],
	});
}

/** Convenience: a clean, committed, untouched workspace. */
export function cleanWorkspace(): FakeGit {
	return createFakeGit({
		head: "a".repeat(40),
		branch: "main",
		files: [
			{ path: "README.md", status: "  ", indexBlob: "b".repeat(40), content: "# hi\n" },
			{ path: "src/app.ts", status: "  ", indexBlob: "c".repeat(40), content: "export const a = 1;\n" },
		],
	});
}
