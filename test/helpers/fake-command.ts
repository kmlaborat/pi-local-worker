import type {
	CommandRunner,
	CommandRunOptions,
	CommandRunResult,
} from "../../src/verification.ts";

/** A canned validation-command outcome. */
export interface FakeCommand {
	argv: readonly string[];
	result: Partial<CommandRunResult> & { exitCode?: number | null };
}

export interface FakeCommandRunner {
	runner: CommandRunner;
	/** Every argv the runner was asked to execute. */
	readonly calls: Array<{ argv: readonly string[]; options: CommandRunOptions }>;
	callsFor(argv: readonly string[]): number;
}

/**
 * Command runner backed by a fixed table of outcomes.
 *
 * No real subprocess is spawned, so exit codes, launch failures and timeouts are
 * all declared rather than arranged, and tests stay deterministic and fast.
 */
export function createFakeCommandRunner(commands: FakeCommand[] = []): FakeCommandRunner {
	const calls: Array<{ argv: readonly string[]; options: CommandRunOptions }> = [];

	const runner: CommandRunner = {
		run(argv, options) {
			calls.push({ argv: [...argv], options });
			const match = commands.find((c) => c.argv.join("\u0000") === argv.join("\u0000"));
			if (!match) {
				// Not in the table: treat as unlaunchable, which must verify as
				// unverifiable rather than unsatisfied.
				return {
					started: false,
					exitCode: null,
					timedOut: false,
					stdout: "",
					stderr: `fake runner: no canned result for ${argv.join(" ")}`,
				};
			}
			return {
				started: match.result.started ?? true,
				exitCode: match.result.exitCode ?? null,
				timedOut: match.result.timedOut ?? false,
				stdout: match.result.stdout ?? "",
				stderr: match.result.stderr ?? "",
			};
		},
	};

	return {
		runner,
		calls,
		callsFor(argv) {
			return calls.filter((c) => c.argv.join("\u0000") === argv.join("\u0000")).length;
		},
	};
}

/** A workspace-evidence view with a given Worker-induced change set. */
export function evidenceWith(paths: string[], status: "available" | "unavailable" = "available") {
	return {
		verificationStatus: status,
		changedFiles: paths.map((path) => ({ path })),
	};
}
