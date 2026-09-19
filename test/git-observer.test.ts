import { describe, expect, test } from "vitest";

import { GitObserver, GitObservationError, splitNul } from "../src/git-observer.ts";
import { cleanWorkspace, createFakeGit, type FakeFile } from "./helpers/fake-git.ts";

function observerFor(fake: ReturnType<typeof createFakeGit>, maxHashBytes?: number) {
	return new GitObserver({ cwd: fake.dir, runner: fake.runner, maxHashBytes });
}

describe("splitNul", () => {
	test("empty string yields no fields", () => {
		expect(splitNul("")).toEqual([]);
	});

	test("trailing NUL does not produce a phantom empty field", () => {
		expect(splitNul("a\0b\0")).toEqual(["a", "b"]);
	});

	test("interior empty fields are preserved", () => {
		expect(splitNul("a\0\0b\0")).toEqual(["a", "", "b"]);
	});
});

describe("GitObserver.capture", () => {
	test("clean workspace: every path is index-blob identified, nothing dirty", () => {
		const fake = cleanWorkspace();
		try {
			const snap = observerFor(fake).capture();
			expect(snap.head).toBe("a".repeat(40));
			expect(snap.branch).toBe("main");
			expect([...snap.files.keys()]).toEqual(["README.md", "src/app.ts"]);
			for (const identity of snap.files.values()) {
				expect(identity.identity).toBe("index-blob");
				expect(identity.exists).toBe(true);
				expect(identity.tracked).toBe(true);
				expect(identity.untracked).toBe(false);
				expect(identity.staged).toBe(false);
			}
		} finally {
			fake.cleanup();
		}
	});

	test("unborn HEAD is a valid baseline, not a failure", () => {
		const fake = createFakeGit({
			head: null,
			branch: null,
			files: [{ path: "brand-new.txt", status: "??", content: "x\n" }],
		});
		try {
			const snap = observerFor(fake).capture();
			expect(snap.head).toBeNull();
			expect(snap.files.get("brand-new.txt")?.untracked).toBe(true);
			expect(snap.files.get("brand-new.txt")?.identity).toBe("content-hash");
		} finally {
			fake.cleanup();
		}
	});

	test("not a git work tree throws instead of reporting an empty snapshot", () => {
		const fake = createFakeGit({ fail: { insideWorkTree: "fatal: not a git repository" } });
		try {
			expect(() => observerFor(fake).capture()).toThrow(GitObservationError);
		} finally {
			fake.cleanup();
		}
	});

	test("git status failure propagates as GitObservationError", () => {
		const fake = createFakeGit({ fail: { status: "fatal: cannot lock index" } });
		try {
			expect(() => observerFor(fake).capture()).toThrow(/git status failed/);
		} finally {
			fake.cleanup();
		}
	});

	test("filename with spaces is parsed without quoting or splitting", () => {
		const fake = createFakeGit({
			files: [{ path: "my reports/q1 final.txt", status: " M", indexBlob: "d".repeat(40), content: "x\n" }],
		});
		try {
			const snap = observerFor(fake).capture();
			expect(snap.files.has("my reports/q1 final.txt")).toBe(true);
		} finally {
			fake.cleanup();
		}
	});

	test("Unicode filename round-trips byte-exactly", () => {
		const name = "docs/ユニコード-日本語.txt";
		const fake = createFakeGit({
			files: [{ path: name, status: " M", indexBlob: "e".repeat(40), content: "x\n" }],
		});
		try {
			const snap = observerFor(fake).capture();
			expect(snap.files.has(name)).toBe(true);
			expect(snap.files.get(name)?.contentHash).toMatch(/^[0-9a-f]{40}$/);
		} finally {
			fake.cleanup();
		}
	});

	test("staged rename consumes the extra origin field so the next entry is not shifted", () => {
		// Git emits: "R  new.txt\0old.txt\0" — the origin is a separate field.
		// If the parser did not consume it, "old.txt" would be misread as a status
		// line and the following entry would be corrupted.
		const fake = createFakeGit({
			files: [
				{ path: "new-name.ts", status: "R ", indexBlob: "f".repeat(40), origin: "old-name.ts" },
				{ path: "after-rename.txt", status: " M", indexBlob: "1".repeat(40), content: "y\n" },
			],
		});
		try {
			const snap = observerFor(fake).capture();
			expect(snap.files.has("new-name.ts")).toBe(true);
			expect(snap.files.get("new-name.ts")?.status).toBe("R ");
			// The origin must NOT appear as its own entry.
			expect(snap.files.has("old-name.ts")).toBe(false);
			// The entry after the rename must still be parsed correctly.
			expect(snap.files.get("after-rename.txt")?.status).toBe(" M");
		} finally {
			fake.cleanup();
		}
	});

	test("files over the hash cap fall back to size-only identity", () => {
		const big = "z".repeat(5000);
		const fake = createFakeGit({
			files: [{ path: "huge.bin", status: "??", content: big }],
		});
		try {
			const snap = observerFor(fake, 1000).capture();
			const identity = snap.files.get("huge.bin");
			expect(identity?.identity).toBe("size-only");
			expect(identity?.size).toBe(5000);
			expect(identity?.contentHash).toBeUndefined();
		} finally {
			fake.cleanup();
		}
	});

	test("deleted-in-worktree file is recorded as absent", () => {
		const fake = createFakeGit({
			files: [{ path: "gone.ts", status: " D", indexBlob: "2".repeat(40) }],
		});
		try {
			const snap = observerFor(fake).capture();
			expect(snap.files.get("gone.ts")?.exists).toBe(false);
			expect(snap.files.get("gone.ts")?.identity).toBe("absent");
		} finally {
			fake.cleanup();
		}
	});
});

describe("GitObserver identity sources", () => {
	test("clean tracked file is identified by index blob with no content hash", () => {
		const files: FakeFile[] = [
			{ path: "clean.ts", status: "  ", indexBlob: "3".repeat(40), content: "unchanged\n" },
		];
		const fake = createFakeGit({ files });
		try {
			const snap = observerFor(fake).capture();
			expect(snap.files.get("clean.ts")?.identity).toBe("index-blob");
			expect(snap.files.get("clean.ts")?.contentHash).toBeUndefined();
		} finally {
			fake.cleanup();
		}
	});

	test("dirty tracked file is content-hashed", () => {
		const fake = createFakeGit({
			files: [{ path: "dirty.ts", status: " M", indexBlob: "4".repeat(40), content: "changed\n" }],
		});
		try {
			const snap = observerFor(fake).capture();
			expect(snap.files.get("dirty.ts")?.identity).toBe("content-hash");
			expect(snap.files.get("dirty.ts")?.contentHash).toMatch(/^[0-9a-f]{40}$/);
		} finally {
			fake.cleanup();
		}
	});

	test("staged file is reported as staged", () => {
		const fake = createFakeGit({
			files: [{ path: "staged.ts", status: "M ", indexBlob: "5".repeat(40), content: "staged\n" }],
		});
		try {
			const snap = observerFor(fake).capture();
			expect(snap.files.get("staged.ts")?.staged).toBe(true);
		} finally {
			fake.cleanup();
		}
	});
});
