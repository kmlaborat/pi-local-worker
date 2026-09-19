import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { GitObserver, gitBlobOid, systemGitRunner } from "../src/git-observer.ts";
import { collectWorkspaceEvidence } from "../src/workspace-evidence.ts";

/**
 * Real-Git coverage.
 *
 * The other suites inject a fake runner, which is right for logic but blind to
 * integration faults: a broken `require`, a wrong argv, or an output shape that
 * differs from what the fake assumed. This file runs the actual `git` binary
 * against a real temporary repository so those faults surface in `npm test`
 * rather than only in manual verification.
 */

const ROOT = join(process.env.TEMP || "/tmp", `pilw-s7-realgit-${process.pid}`);
const REPO = join(ROOT, "repo");

function sh(args: string[]): string {
	return execFileSync("git", args, { cwd: REPO, encoding: "utf8" });
}

function file(name: string, content: string): void {
	const target = join(REPO, name);
	mkdirSync(join(target, ".."), { recursive: true });
	writeFileSync(target, content, "utf8");
}

function capture() {
	return new GitObserver({ cwd: REPO, runner: systemGitRunner }).capture();
}

beforeAll(() => {
	rmSync(ROOT, { recursive: true, force: true });
	mkdirSync(REPO, { recursive: true });
	sh(["init", "-q", "."]);
	sh(["config", "user.email", "t@t.t"]);
	sh(["config", "user.name", "t"]);
	sh(["config", "commit.gpgsign", "false"]);

	file("README.md", "# real\n");
	file("src/app.ts", "export const a = 1;\n");
	file("src/staged.ts", "export const s = 1;\n");
	file("docs/sp ace.md", "# spaced\n");
	file("docs/ユニコード.md", "# unicode\n");
	file(".gitignore", "ignored.txt\n");
	sh(["add", "-A"]);
	sh(["commit", "-qm", "seed"]);
});

afterAll(() => {
	rmSync(ROOT, { recursive: true, force: true });
});

describe("real git — snapshot capture", () => {
	test("clean repo snapshot reports the real HEAD and no dirt", () => {
		const snap = capture();
		expect(snap.head).toMatch(/^[0-9a-f]{40}$/);
		expect(snap.branch).toBeTruthy();
		// A clean tree yields no dirty and no untracked paths.
		const dirty = [...snap.files.values()].filter(
			(f) => f.tracked && f.status !== undefined && f.status !== "  ",
		);
		expect(dirty).toEqual([]);
	});

	test("systemGitRunner actually shells out (no require/ESM fault)", () => {
		// Regression guard: the runner previously used require() inside an ESM
		// module, which threw at runtime while every fake-runner test stayed green.
		const result = systemGitRunner.run(["rev-parse", "--is-inside-work-tree"], REPO);
		expect(result.ok).toBe(true);
		expect(result.stdout.trim()).toBe("true");
		expect(result.stderr).toBe("");
	});

	test("locally computed blob oid matches real `git hash-object`", () => {
		// Conformance guard: the local sha1 blob computation must agree with Git
		// itself, or every oid comparison against the index is meaningless.
		const samples = [
			"export const a = 1;\n",
			"",
			"same length but different 2\n",
			"unicode ünïcode ユニコード\n",
		];
		for (const [i, content] of samples.entries()) {
			const name = `oid-check-${i}.txt`;
			file(name, content);
			const real = sh(["hash-object", name]).trim();
			expect(gitBlobOid(content)).toBe(real);
			rmSync(join(REPO, name));
		}
	});

	test("runner failure is reported, not thrown", () => {
		const result = systemGitRunner.run(["definitely-not-a-git-command"], REPO);
		expect(result.ok).toBe(false);
		expect(result.code).not.toBe(0);
	});
});

describe("real git — change detection", () => {
	test("unstaged modification is detected", () => {
		const baseline = capture();
		file("src/app.ts", "export const a = 2;\n");
		const ev = collectWorkspaceEvidence({ cwd: REPO, baseline, runner: systemGitRunner });
		expect(ev.verificationStatus).toBe("available");
		expect(ev.changedFiles.map((f) => `${f.status} ${f.path}`)).toEqual(["M src/app.ts"]);
		sh(["checkout", "--", "src/app.ts"]);
	});

	test("staged modification is detected and flagged staged", () => {
		const baseline = capture();
		file("src/staged.ts", "export const s = 99;\n");
		sh(["add", "src/staged.ts"]);
		const ev = collectWorkspaceEvidence({ cwd: REPO, baseline, runner: systemGitRunner });
		expect(ev.changedFiles.map((f) => `${f.status} ${f.path}`)).toEqual(["M src/staged.ts"]);
		expect(ev.changedFiles[0]!.staged).toBe(true);
		sh(["reset", "-q", "HEAD", "--", "src/staged.ts"]);
		sh(["checkout", "--", "src/staged.ts"]);
	});

	test("new untracked file is detected with a content hash and no diff claim", () => {
		const baseline = capture();
		file("brand-new.txt", "produced by the worker\n");
		const ev = collectWorkspaceEvidence({ cwd: REPO, baseline, runner: systemGitRunner });
		expect(ev.changedFiles.map((f) => `${f.status} ${f.path}`)).toEqual(["A brand-new.txt"]);
		const added = ev.changedFiles[0]!;
		expect(added.untrackedNow).toBe(true);
		expect(added.contentHashAfter).toMatch(/^[0-9a-f]{40}$/);
		expect(added.patchAvailable).toBe(false);
		rmSync(join(REPO, "brand-new.txt"));
	});

	test("deletion is detected", () => {
		const baseline = capture();
		rmSync(join(REPO, "docs/sp ace.md"));
		const ev = collectWorkspaceEvidence({ cwd: REPO, baseline, runner: systemGitRunner });
		expect(ev.changedFiles.map((f) => `${f.status} ${f.path}`)).toEqual(["D docs/sp ace.md"]);
		sh(["checkout", "--", "docs/sp ace.md"]);
	});

	test("Unicode and space filenames parse exactly", () => {
		const baseline = capture();
		file("docs/ユニコード.md", "# unicode changed\n");
		file("docs/sp ace.md", "# spaced changed\n");
		const ev = collectWorkspaceEvidence({ cwd: REPO, baseline, runner: systemGitRunner });
		const got = ev.changedFiles.map((f) => f.path).sort();
		expect(got).toEqual(["docs/sp ace.md", "docs/ユニコード.md"]);
		sh(["checkout", "--", "docs/ユニコード.md", "docs/sp ace.md"]);
	});

	test("a real `git mv` is reported as R with the origin, not as D + A", () => {
		file("mv-src.ts", "content that will be renamed\n");
		sh(["add", "mv-src.ts"]);
		sh(["commit", "-qm", "add mv-src"]);

		const baseline = capture();
		sh(["mv", "mv-src.ts", "mv-dst.ts"]);
		const ev = collectWorkspaceEvidence({ cwd: REPO, baseline, runner: systemGitRunner });
		expect(ev.changedFiles.map((f) => f.status)).toEqual(["R"]);
		expect(ev.changedFiles[0]!.path).toBe("mv-dst.ts");
		expect(ev.changedFiles[0]!.oldPath).toBe("mv-src.ts");
		sh(["mv", "mv-dst.ts", "mv-src.ts"]);
	});

	test("gitignored files are never reported as changes", () => {
		const baseline = capture();
		file("ignored.txt", "build artifact\n");
		const ev = collectWorkspaceEvidence({ cwd: REPO, baseline, runner: systemGitRunner });
		expect(ev.changedFiles).toEqual([]);
		rmSync(join(REPO, "ignored.txt"));
	});

	test("pre-existing dirt is recorded but not attributed to the Worker", () => {
		file("user-dirty.ts", "// user work\n");
		sh(["add", "user-dirty.ts"]);
		const baseline = capture();
		// Worker changes nothing.
		const ev = collectWorkspaceEvidence({ cwd: REPO, baseline, runner: systemGitRunner });
		expect(ev.changedFiles).toEqual([]);
		expect(ev.baseline?.preExistingDirtyPaths).toContain("user-dirty.ts");
		sh(["reset", "-q", "HEAD", "--", "user-dirty.ts"]);
		rmSync(join(REPO, "user-dirty.ts"));
	});
});

describe("real git — diff evidence", () => {
	test("numstat is parsed from real git output", () => {
		const baseline = capture();
		file("src/app.ts", "export const a = 1;\nexport const b = 2;\n");
		const ev = collectWorkspaceEvidence({ cwd: REPO, baseline, runner: systemGitRunner });
		const entry = ev.diffStat.find((e) => e.path === "src/app.ts");
		expect(entry).toBeDefined();
		expect(entry!.binary).toBe(false);
		expect(entry!.added).toBe(1);
		expect(entry!.deleted).toBe(0);
		sh(["checkout", "--", "src/app.ts"]);
	});

	test("patch truncation is explicit and machine-readable", () => {
		// Must be a TRACKED file: `git diff HEAD` carries no untracked content,
		// so an untracked file would produce an empty patch and never truncate.
		file("big-tracked.txt", "original\n");
		sh(["add", "big-tracked.txt"]);
		sh(["commit", "-qm", "add big-tracked"]);

		const baseline = capture();
		file("big-tracked.txt", "rewritten line\n".repeat(2000));
		const ev = collectWorkspaceEvidence({
			cwd: REPO,
			baseline,
			runner: systemGitRunner,
			maxPatchBytes: 500,
		});
		expect(ev.patch).toBeDefined();
		expect(ev.patch!.truncated).toBe(true);
		expect(ev.patch!.byteLimit).toBe(500);
		expect(Buffer.byteLength(ev.patch!.text, "utf8")).toBe(500);
		expect(ev.patch!.totalBytes).toBeGreaterThan(500);
		sh(["checkout", "--", "big-tracked.txt"]);
		rmSync(join(REPO, "big-tracked.txt"));
		sh(["commit", "-qam", "remove big-tracked"]);
	});

	test("REGRESSION: a same-size edit is still detected as a change", () => {
		// The earlier size-based fallback made a byte-length-preserving edit
		// invisible. Git blob oids make it impossible.
		file("same-size.ts", "export const v = 1;\n");
		sh(["add", "same-size.ts"]);
		sh(["commit", "-qm", "add same-size"]);

		const baseline = capture();
		const before = readFileSync(join(REPO, "same-size.ts"), "utf8");
		file("same-size.ts", "export const v = 2;\n");
		const after = readFileSync(join(REPO, "same-size.ts"), "utf8");
		// Same byte length, different content — the exact trap.
		expect(Buffer.byteLength(before)).toBe(Buffer.byteLength(after));

		const ev = collectWorkspaceEvidence({ cwd: REPO, baseline, runner: systemGitRunner });
		expect(ev.changedFiles.map((f) => `${f.status} ${f.path}`)).toEqual(["M same-size.ts"]);
		sh(["checkout", "--", "same-size.ts"]);
	});

	test("REGRESSION: staging unchanged content is NOT reported as a change", () => {
		// Baseline worktree == index. Worker stages the same bytes.
		// Nothing changed; the oid comparison must say so.
		const baseline = capture();
		sh(["add", "src/app.ts"]);
		const ev = collectWorkspaceEvidence({ cwd: REPO, baseline, runner: systemGitRunner });
		expect(ev.changedFiles.filter((f) => f.path === "src/app.ts")).toEqual([]);
	});
});

describe("real git — non-repository", () => {
	test("a directory that is not a repo fails the snapshot explicitly", () => {
		// The temp root may itself sit inside a repository on this machine, so
		// GIT_CEILING_DIRECTORIES is used to make the directory genuinely
		// repo-free for real git rather than depending on the host layout.
		const plain = join(ROOT, "plain-dir");
		mkdirSync(plain, { recursive: true });
		const ceilingRunner = {
			run(args: readonly string[], cwd: string) {
				try {
					const stdout = execFileSync("git", [...args], {
						cwd,
						encoding: "utf8",
						env: { ...process.env, GIT_CEILING_DIRECTORIES: ROOT },
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
		const observer = new GitObserver({ cwd: plain, runner: ceilingRunner });
		expect(observer.isWorkTree()).toBe(false);
		expect(() => observer.capture()).toThrow(/not a git work tree/);

		const ev = collectWorkspaceEvidence({
			cwd: plain,
			baseline: undefined,
			baselineError: "not a git work tree",
			runner: ceilingRunner,
		});
		expect(ev.verificationStatus).toBe("unavailable");
		expect(ev.changedFiles).toEqual([]);
	});
});
