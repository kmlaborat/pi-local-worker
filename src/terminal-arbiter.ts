/**
 * Single point of terminal-state arbitration.
 *
 * Four components could otherwise each decide the Worker's fate independently:
 * the state tracker (native lifecycle), the timeout guard, the AbortSignal
 * listener, and the settle path after `prompt()` resolves. Step 6 requires that
 * exactly one of them wins and that nothing can change the outcome afterwards.
 *
 * The rule is deliberately simple: **first valid decision wins**. There is no
 * priority table. The race cases in the specification are about ordering, not
 * precedence, and a first-wins latch is the only semantics that makes
 * "no later event may change the terminal state" true.
 */
export type TerminalCause = "FINISHED" | "ERROR" | "ABORTED" | "TIMEOUT";

export interface TerminalDecision {
	cause: TerminalCause;
	/** Clock time at which the terminal state was decided. */
	at: number;
	/** Human-readable explanation. Never the only signal. */
	reason: string;
}

export class TerminalArbiter {
	private _decision: TerminalDecision | undefined;
	private waiters: Array<(decision: TerminalDecision) => void> = [];

	public constructor(private readonly now: () => number) {}

	public get decision(): TerminalDecision | undefined {
		return this._decision;
	}

	public get decided(): boolean {
		return this._decision !== undefined;
	}

	public get cause(): TerminalCause | undefined {
		return this._decision?.cause;
	}

	/**
	 * Attempt to set the terminal state.
	 *
	 * Returns `true` if this call won the race, `false` if a terminal state was
	 * already decided (in which case the existing decision stands and this one is
	 * recorded as a loser for diagnostics).
	 */
	public decide(cause: TerminalCause, reason: string): boolean {
		if (this._decision) {
			this.lost.push({ cause, at: this.now(), reason });
			return false;
		}
		this._decision = { cause, at: this.now(), reason };
		const waiters = this.waiters;
		this.waiters = [];
		for (const resolve of waiters) {
			resolve(this._decision);
		}
		return true;
	}

	/** Decisions that arrived after the winner. Diagnostics only. */
	public readonly lost: TerminalDecision[] = [];

	/** Resolves with the winning decision, immediately if already decided. */
	public wait(): Promise<TerminalDecision> {
		if (this._decision) {
			return Promise.resolve(this._decision);
		}
		return new Promise((resolve) => {
			this.waiters.push(resolve);
		});
	}
}
