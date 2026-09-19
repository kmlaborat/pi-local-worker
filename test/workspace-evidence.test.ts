import { describe, expect, test } from "vitest";

import { GitObserver } from "../src/git-observer.ts";
import {
	collectWorkspaceEvidence,
	type ChangedFile,
	type CollectWorkspaceEvidenceOptions,
} from "../src/workspace-evidence.ts";
import { cleanWorkspace, createFakeGit, type FakeFile } from "./helpers/fake-git.ts";

/**
 * Capture a baseline from `fake`, then move the declared workspace to `after`,
 * then collect the evidence. Mirrors the harness ordering:
 * baseline -> (worker acts) -> final observation.
 */
function run(
	fake: ReturnType<typeof createFakeGit>,
	after: FakeFile[],
	extra: Partial<CollectWorkspaceEvidenceOptions> = {},
) {
	const observer = new GitObserver({
		cwd: fake.dir,
		runner: fake.runner,
		maxHashBytes: extra.maxHashBytes,
	});
	const baseline = observer.capture();
	fake.setFiles(after);
	return collectWorkspaceEvidence({
		cwd: fake.dir,
		baseline,
		runner: fake.runner,
		maxHashBytes: extra.maxHashBytes,
		maxPatchBytes: extra.maxPatchBytes,
	});
}

function paths(evidence: { changedFiles: readonly ChangedFile[] }): string[] {
	return evidence.changedFiles.map((f) => `${f.status} ${f.path}`).sort();
}

const CLEAN: FakeFile[] = [
	{ path: "README.md", status: "  ", indexBlob: "a".repeat(40), content: "# hi\n" },
	{ path: "src/app.ts", status: "  ", indexBlob: "b".repeat(40), content: "export const a = 1;\n" },
];

describe("A/B — no Worker-induced change", () => {
	test("A: clean baseline, clean final -> empty change set", () => {
		const fake = createFakeGit({ files: CLEAN });
		try {
			const evidence = run(fake, CLEAN);
			expect(evidence.verificationStatus).toBe("available");
			expect(evidence.changedFiles).toEqual([]);
		} finally {
			fake.cleanup();
		}
	});

	test("B: pre-existing dirty workspace, Worker changes nothing -> empty change set", () => {
		const dirty: FakeFile[] = [
			...CLEAN,
			{
				path: "user-existing.ts",
				status: " M",
				indexBlob: "c".repeat(40),
				content: "user work in progress\n",
			},
			{ path: "user-notes.md", status: "??", content: "scratch\n" },
		];
		const fake = createFakeGit({ files: dirty });
		try {
			const evidence = run(fake, dirty);
			expect(evidence.verificationStatus).toBe("available");
			// The whole point: a dirty tree is NOT a Worker change.
			expect(evidence.changedFiles).toEqual([]);
			// ...but the pre-existing state is recorded, not hidden.
			expect(evidence.baseline?.preExistingDirtyPaths).toEqual(["user-existing.ts"]);
			expect(evidence.baseline?.preExistingUntrackedPaths).toEqual(["user-notes.md"]);
		} finally {
			fake.cleanup();
		}
	});
});

describe("C–H — Worker changes against a dirty workspace", () => {
	test("C: pre-existing dirty + Worker modifies a different file -> only the Worker change", () => {
		const workerFile: FakeFile = {
			path: "src/worker.ts",
			status: "  ",
			indexBlob: "d".repeat(40),
			content: "original\n",
		};
		const before: FakeFile[] = [
			...CLEAN,
			workerFile,
			{ path: "user-existing.ts", status: " M", indexBlob: "c".repeat(40), content: "user\n" },
		];
		const after: FakeFile[] = [
			CLEAN[0]!,
			CLEAN[1]!,
			{ ...workerFile, status: " M", content: "worker change\n" },
			{ path: "user-existing.ts", status: " M", indexBlob: "c".repeat(40), content: "user\n" },
		];
		const fake = createFakeGit({ files: before });
		try {
			const evidence = run(fake, after);
			// The user's pre-existing edit is NOT reported; only the Worker's is.
			expect(paths(evidence)).toEqual(["M src/worker.ts"]);
			expect(evidence.changedFiles[0]!.includesPreExistingChanges).toBe(false);
		} finally {
			fake.cleanup();
		}
	});

	test("D: Worker creates a new untracked file -> detected with no git diff", () => {
		const fake = createFakeGit({ files: CLEAN });
		try {
			const evidence = run(fake, [
				...CLEAN,
				{ path: "generated.txt", status: "??", content: "produced\n" },
			]);
			expect(paths(evidence)).toEqual(["A generated.txt"]);
			const file = evidence.changedFiles[0]!;
			expect(file.untrackedNow).toBe(true);
			expect(file.untrackedAtBaseline).toBe(false);
			expect(file.sizeAfter).toBe(Buffer.byteLength("produced\n"));
			expect(file.contentHashAfter).toMatch(/^[0-9a-f]{40}$/);
			// No textual diff exists for an untracked file.
			expect(file.patchAvailable).toBe(false);
		} finally {
			fake.cleanup();
		}
	});

	test("E: Worker deletes a file -> detected as D", () => {
		const fake = createFakeGit({ files: CLEAN });
		try {
			const evidence = run(fake, [CLEAN[0]!]);
			expect(paths(evidence)).toEqual(["D src/app.ts"]);
			// No "after" size or hash is claimed for a file that no longer exists.
			expect(evidence.changedFiles[0]!.sizeAfter).toBeUndefined();
			expect(evidence.changedFiles[0]!.contentHashAfter).toBeUndefined();
			expect(evidence.changedFiles[0]!.sizeBefore).toBeDefined();
		} finally {
			fake.cleanup();
		}
	});

	test("F: Worker stages a modification -> still detected", () => {
		const fake = createFakeGit({ files: CLEAN });
		try {
			const evidence = run(fake, [
				CLEAN[0]!,
				{ path: "src/app.ts", status: "M ", indexBlob: "e".repeat(40), content: "staged!\n" },
			]);
			expect(paths(evidence)).toEqual(["M src/app.ts"]);
			expect(evidence.changedFiles[0]!.staged).toBe(true);
		} finally {
			fake.cleanup();
		}
	});

	test("G: Worker leaves the change unstaged -> detected", () => {
		const fake = createFakeGit({ files: CLEAN });
		try {
			const evidence = run(fake, [
				CLEAN[0]!,
				{ path: "src/app.ts", status: " M", indexBlob: "b".repeat(40), content: "unstaged!\n" },
			]);
			expect(paths(evidence)).toEqual(["M src/app.ts"]);
			expect(evidence.changedFiles[0]!.staged).toBe(false);
		} finally {
			fake.cleanup();
		}
	});

	test("H: staged and unstaged changes on different files are both represented", () => {
		const fake = createFakeGit({ files: CLEAN });
		try {
			const evidence = run(fake, [
				{ path: "README.md", status: "M ", indexBlob: "f".repeat(40), content: "staged\n" },
				{ path: "src/app.ts", status: " M", indexBlob: "b".repeat(40), content: "unstaged\n" },
			]);
			expect(paths(evidence)).toEqual(["M README.md", "M src/app.ts"]);
			const byPath = Object.fromEntries(evidence.changedFiles.map((f) => [f.path, f.staged]));
			expect(byPath).toEqual({ "README.md": true, "src/app.ts": false });
		} finally {
			fake.cleanup();
		}
	});

	test("H2: a file dirty at baseline and changed again by the Worker is flagged", () => {
		const before: FakeFile[] = [
			CLEAN[0]!,
			{ path: "shared.ts", status: " M", indexBlob: "1".repeat(40), content: "user version\n" },
		];
		const after: FakeFile[] = [
			CLEAN[0]!,
			{ path: "shared.ts", status: " M", indexBlob: "1".repeat(40), content: "user + worker\n" },
		];
		const fake = createFakeGit({ files: before });
		try {
			const evidence = run(fake, after);
			expect(paths(evidence)).toEqual(["M shared.ts"]);
			expect(evidence.changedFiles[0]!.includesPreExistingChanges).toBe(true);
		} finally {
			fake.cleanup();
		}
	});
});

describe("I — renames", () => {
	test("staged rename is reported as R using Git's own detection", () => {
		const before: FakeFile[] = [
			CLEAN[0]!,
			{ path: "old-name.ts", status: "  ", indexBlob: "9".repeat(40), content: "same\n" },
		];
		const after: FakeFile[] = [
			CLEAN[0]!,
			{ path: "new-name.ts", status: "R ", indexBlob: "9".repeat(40), origin: "old-name.ts", content: "same\n" },
		];
		const fake = createFakeGit({ files: before });
		try {
			const evidence = run(fake, after);
			// Git paired the paths itself, so the rename is reported once as R,
			// not as an unrelated D + A pair.
			expect(paths(evidence)).toEqual(["R new-name.ts"]);
			const renamed = evidence.changedFiles[0]!;
			expect(renamed.path).toBe("new-name.ts");
			expect(renamed.oldPath).toBe("old-name.ts");
			expect(renamed.staged).toBe(true);
		} finally {
			fake.cleanup();
		}
	});

	test("unstaged rename is reported as D + A, not as a rename", () => {
		// Git reports an unstaged rename as a delete plus an untracked add.
		// Step 7 documents this rather than guessing intent.
		const before: FakeFile[] = [
			CLEAN[0]!,
			{ path: "before.ts", status: "  ", indexBlob: "7".repeat(40), content: "content\n" },
		];
		const after: FakeFile[] = [
			CLEAN[0]!,
			{ path: "after.ts", status: "??", content: "content\n" },
		];
		const fake = createFakeGit({ files: before });
		try {
			const evidence = run(fake, after);
			expect(paths(evidence)).toEqual(["A after.ts", "D before.ts"]);
		} finally {
			fake.cleanup();
		}
	});
});

describe("J/K — filename edge cases", () => {
	test("J: Unicode filename is compared deterministically", () => {
		const name = "docs/日本語-ünïcode.txt";
		const fake = createFakeGit({ files: CLEAN });
		try {
			const evidence = run(fake, [...CLEAN, { path: name, status: "??", content: "unicode\n" }]);
			expect(paths(evidence)).toEqual([`A ${name}`]);
		} finally {
			fake.cleanup();
		}
	});

	test("K: filename with spaces is neither split nor quoted away", () => {
		const name = "my reports/q1 final v2.txt";
		const fake = createFakeGit({ files: CLEAN });
		try {
			const evidence = run(fake, [...CLEAN, { path: name, status: "??", content: "spaced\n" }]);
			expect(paths(evidence)).toEqual([`A ${name}`]);
			expect(evidence.changedFiles[0]!.path).toBe(name);
		} finally {
			fake.cleanup();
		}
	});
});

describe("L/M — observation failure", () => {
	test("L: no baseline -> unavailable, no fabricated change list", () => {
		const evidence = collectWorkspaceEvidence({
			cwd: process.cwd(),
			baseline: undefined,
			baselineError: "fatal: not a git repository",
		});
		expect(evidence.verificationStatus).toBe("unavailable");
		expect(evidence.changedFiles).toEqual([]);
		expect(evidence.errors.join(" ")).toMatch(/baseline capture failed/);
		expect(evidence.errors.join(" ")).toMatch(/not a git repository/);
	});

	test("L2: final observation failure -> unavailable, changedFiles not invented", () => {
		const fake = createFakeGit({ files: CLEAN });
		try {
			const observer = new GitObserver({ cwd: fake.dir, runner: fake.runner });
			const baseline = observer.capture();
			fake.setFail({ status: "fatal: cannot lock index" });
			const evidence = collectWorkspaceEvidence({
				cwd: fake.dir,
				baseline,
				runner: fake.runner,
			});
			expect(evidence.verificationStatus).toBe("unavailable");
			expect(evidence.changedFiles).toEqual([]);
			expect(evidence.errors.join(" ")).toMatch(/final observation failed/);
		} finally {
			fake.cleanup();
		}
	});

	test("M: baseline summary survives a final observation failure", () => {
		const before: FakeFile[] = [
			CLEAN[0]!,
			{ path: "user-existing.ts", status: " M", indexBlob: "c".repeat(40), content: "user\n" },
		];
		const fake = createFakeGit({ files: before });
		try {
			const observer = new GitObserver({ cwd: fake.dir, runner: fake.runner });
			const baseline = observer.capture();
			fake.setFail({ status: "fatal: cannot lock index" });
			const evidence = collectWorkspaceEvidence({ cwd: fake.dir, baseline, runner: fake.runner });
			// §21: baseline stays available even though the final observation failed.
			expect(evidence.baseline).toBeDefined();
			expect(evidence.baseline?.preExistingDirtyPaths).toEqual(["user-existing.ts"]);
			expect(evidence.verificationStatus).toBe("unavailable");
		} finally {
			fake.cleanup();
		}
	});
});

describe("S — patch size limit", () => {
	test("oversized patch is truncated with explicit machine-readable reporting", () => {
		const fake = createFakeGit({ files: CLEAN, patch: "x".repeat(10_000) });
		try {
			const evidence = run(fake, CLEAN, { maxPatchBytes: 1000 });
			expect(evidence.patch).toBeDefined();
			expect(evidence.patch!.truncated).toBe(true);
			expect(evidence.patch!.byteLimit).toBe(1000);
			expect(evidence.patch!.totalBytes).toBe(10_000);
			expect(Buffer.byteLength(evidence.patch!.text, "utf8")).toBe(1000);
			expect(evidence.patch!.reference).toBe("HEAD");
		} finally {
			fake.cleanup();
		}
	});

	test("small patch is retained whole", () => {
		const fake = createFakeGit({ files: CLEAN, patch: "diff --git a/x b/x\n" });
		try {
			const evidence = run(fake, CLEAN, { maxPatchBytes: 5000 });
			expect(evidence.patch!.truncated).toBe(false);
			expect(evidence.patch!.text).toBe("diff --git a/x b/x\n");
		} finally {
			fake.cleanup();
		}
	});
});

describe("Evidence is observation, not verdict", () => {
	test("no field expresses correctness, completion or policy", () => {
		const fake = cleanWorkspace();
		try {
			const evidence = run(fake, [
				...CLEAN,
				{ path: "forbidden.txt", status: "??", content: "naughty\n" },
			]);
			const serialized = JSON.stringify(evidence).toLowerCase();
			for (const banned of ["correct", "incorrect", "passed", "failed", "violat", "complete"]) {
				expect(serialized).not.toContain(banned);
			}
		} finally {
			fake.cleanup();
		}
	});

	test("documented limitations are always present and machine-readable", () => {
		const fake = cleanWorkspace();
		try {
			const evidence = run(fake, [...CLEAN, { path: "gen.txt", status: "??", content: "x\n" }]);
			expect(evidence.limitations.length).toBeGreaterThan(0);
			expect(evidence.limitations.join(" ")).toMatch(/\.gitignore/);
			expect(evidence.limitations.join(" ")).toMatch(/measured against HEAD/);
		} finally {
			fake.cleanup();
		}
	});
});
