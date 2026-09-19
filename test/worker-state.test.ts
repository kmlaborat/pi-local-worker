import { describe, expect, test } from "vitest";

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { WorkerState } from "../src/worker-state.ts";
import { WorkerStateTracker, type WorkerStateSnapshot } from "../src/worker-state.ts";
import { WorkerHarness } from "../src/worker-harness.ts";
import type { TaskSpec } from "../src/task-spec.ts";
import { FakeWorkerSession } from "./helpers/fake-session.ts";

function trackerFor(
	initial: { pending?: number; aborted?: boolean } = {},
): { tracker: WorkerStateTracker; pending: { value: number }; aborted: { value: boolean } } {
	const pending = { value: initial.pending ?? 0 };
	const aborted = { value: initial.aborted ?? false };
	const tracker = new WorkerStateTracker({
		getPendingToolCalls: () => pending.value,
		isAborted: () => aborted.value,
	});
	return { tracker, pending, aborted };
}

function ev(event: Record<string, unknown>): AgentSessionEvent {
	return event as unknown as AgentSessionEvent;
}

const assistantMsg = (stopReason = "stop") => ({ role: "assistant", stopReason, content: [] });

describe("WorkerStateTracker — baseline", () => {
	test("starts in INITIALIZING", () => {
		const { tracker } = trackerFor();
		expect(tracker.state).toBe("INITIALIZING");
	});

	test("agent_start enters the active lifecycle", () => {
		const { tracker } = trackerFor();
		expect(tracker.handle(ev({ type: "agent_start" }))).toBe("WAITING_FOR_LLM");
	});

	test("assistant message_start / message_update produce LLM_GENERATING", () => {
		const { tracker } = trackerFor();
		tracker.handle(ev({ type: "agent_start" }));
		expect(tracker.handle(ev({ type: "turn_start" }))).toBe("WAITING_FOR_LLM");
		expect(tracker.handle(ev({ type: "message_start", message: assistantMsg("pending") }))).toBe("LLM_GENERATING");
		expect(tracker.handle(ev({ type: "message_update", message: assistantMsg("pending") }))).toBe("LLM_GENERATING");
	});

	test("non-assistant message events never produce LLM_GENERATING", () => {
		const { tracker } = trackerFor();
		tracker.handle(ev({ type: "agent_start" }));
		tracker.handle(ev({ type: "turn_start" }));
		const user = { role: "user", content: [] };
		const toolResult = { role: "toolResult", content: [] };
		const custom = { role: "custom", customType: "x", content: [] };
		for (const message of [user, toolResult, custom]) {
			expect(tracker.handle(ev({ type: "message_start", message }))).toBe("WAITING_FOR_LLM");
			expect(tracker.handle(ev({ type: "message_end", message }))).toBe("WAITING_FOR_LLM");
		}
	});
});

describe("WorkerStateTracker — tool state", () => {
	test("pendingToolCalls > 0 produces TOOL_EXECUTING", () => {
		const { tracker, pending } = trackerFor();
		tracker.handle(ev({ type: "agent_start" }));
		tracker.handle(ev({ type: "message_start", message: assistantMsg("toolUse") }));
		pending.value = 1;
		expect(tracker.handle(ev({ type: "tool_execution_start", toolCallId: "a", toolName: "read" }))).toBe(
			"TOOL_EXECUTING",
		);
	});

	test("assistant message_end with tools already in flight yields TOOL_EXECUTING", () => {
		const { tracker, pending } = trackerFor();
		tracker.handle(ev({ type: "agent_start" }));
		pending.value = 1;
		expect(tracker.handle(ev({ type: "message_end", message: assistantMsg("toolUse") }))).toBe("TOOL_EXECUTING");
	});

	test("tool_execution_end with the set still non-empty stays TOOL_EXECUTING", () => {
		const { tracker, pending } = trackerFor({ pending: 2 });
		tracker.handle(ev({ type: "agent_start" }));
		tracker.handle(ev({ type: "tool_execution_start", toolCallId: "a", toolName: "read" }));
		pending.value = 1;
		expect(tracker.handle(ev({ type: "tool_execution_end", toolCallId: "a", toolName: "read" }))).toBe(
			"TOOL_EXECUTING",
		);
	});

	test("tool_execution_end with an empty set returns to WAITING_FOR_LLM", () => {
		const { tracker, pending } = trackerFor({ pending: 1 });
		tracker.handle(ev({ type: "agent_start" }));
		tracker.handle(ev({ type: "tool_execution_start", toolCallId: "a", toolName: "read" }));
		pending.value = 0;
		expect(tracker.handle(ev({ type: "tool_execution_end", toolCallId: "a", toolName: "read" }))).toBe(
			"WAITING_FOR_LLM",
		);
	});

	test("tool_execution_update keeps TOOL_EXECUTING", () => {
		const { tracker } = trackerFor({ pending: 1 });
		tracker.handle(ev({ type: "agent_start" }));
		tracker.handle(ev({ type: "tool_execution_start", toolCallId: "a", toolName: "bash" }));
		expect(
			tracker.handle(ev({ type: "tool_execution_update", toolCallId: "a", toolName: "bash", partialResult: {} })),
		).toBe("TOOL_EXECUTING");
	});
});

describe("WorkerStateTracker — turn / agent lifecycle", () => {
	test("turn_end produces TURN_COMPLETED", () => {
		const { tracker } = trackerFor();
		tracker.handle(ev({ type: "agent_start" }));
		tracker.handle(ev({ type: "message_start", message: assistantMsg() }));
		expect(tracker.handle(ev({ type: "turn_end", message: assistantMsg(), toolResults: [] }))).toBe("TURN_COMPLETED");
	});

	test("agent_end alone never produces FINISHED", () => {
		const { tracker } = trackerFor();
		tracker.handle(ev({ type: "agent_start" }));
		tracker.handle(ev({ type: "turn_end", message: assistantMsg(), toolResults: [] }));
		const after = tracker.handle(ev({ type: "agent_end", messages: [assistantMsg()], willRetry: false }));
		expect(after).toBe("TURN_COMPLETED");
		expect(after).not.toBe("FINISHED");
	});

	test("agent_end with willRetry stays non-terminal", () => {
		const { tracker } = trackerFor();
		tracker.handle(ev({ type: "agent_start" }));
		tracker.handle(ev({ type: "turn_end", message: assistantMsg(), toolResults: [] }));
		const after = tracker.handle(ev({ type: "agent_end", messages: [assistantMsg()], willRetry: true }));
		expect(after).toBe("WAITING_FOR_LLM");
		expect(after).not.toBe("FINISHED");
	});

	test("agent_settled produces FINISHED", () => {
		const { tracker } = trackerFor();
		tracker.handle(ev({ type: "agent_start" }));
		tracker.handle(ev({ type: "turn_end", message: assistantMsg("stop"), toolResults: [] }));
		expect(tracker.handle(ev({ type: "agent_settled" }))).toBe("FINISHED");
	});

	test("agent_settled after an abort produces ABORTED", () => {
		const { tracker, aborted } = trackerFor();
		tracker.handle(ev({ type: "agent_start" }));
		aborted.value = true;
		expect(tracker.handle(ev({ type: "agent_settled" }))).toBe("ABORTED");
	});

	test("agent_settled after an aborted assistant message produces ABORTED", () => {
		const { tracker } = trackerFor();
		tracker.handle(ev({ type: "agent_start" }));
		tracker.handle(ev({ type: "turn_end", message: assistantMsg("aborted"), toolResults: [] }));
		expect(tracker.handle(ev({ type: "agent_settled" }))).toBe("ABORTED");
	});

	test("agent_settled after an error assistant message produces ERROR", () => {
		const { tracker } = trackerFor();
		tracker.handle(ev({ type: "agent_start" }));
		tracker.handle(ev({ type: "turn_end", message: assistantMsg("error"), toolResults: [] }));
		expect(tracker.handle(ev({ type: "agent_settled" }))).toBe("ERROR");
	});

	test("terminal states absorb later events", () => {
		const { tracker } = trackerFor();
		tracker.handle(ev({ type: "agent_start" }));
		tracker.handle(ev({ type: "agent_settled" }));
		expect(tracker.handle(ev({ type: "turn_start" }))).toBe("FINISHED");
		expect(tracker.handle(ev({ type: "tool_execution_start", toolCallId: "x", toolName: "read" }))).toBe("FINISHED");
	});
});

// ---------------------------------------------------------------------------
// Full sequences through the real harness + replayed pi event order.
// ---------------------------------------------------------------------------

function spec(overrides: Partial<TaskSpec> = {}): TaskSpec {
	return {
		taskId: "state-task",
		goal: "state sequence",
		scope: [],
		workType: "implement",
		completionCriteria: ["done"],
		...overrides,
	};
}

function stateSequence(snapshots: WorkerStateSnapshot[]): WorkerState[] {
	return snapshots.map((s) => s.state);
}

describe("WorkerStateTracker — no-tool task sequence", () => {
	test("agent_start -> LLM_GENERATING -> TURN_COMPLETED -> FINISHED", async () => {
		const fake = new FakeWorkerSession({ text: "no tools here" });
		const snapshots: WorkerStateSnapshot[] = [];
		const result = await harnessOf(fake, snapshots).run(spec());

		const states = stateSequence(snapshots);
		expect(states).toContain("WAITING_FOR_LLM");
		expect(states).toContain("LLM_GENERATING");
		expect(states).toContain("TURN_COMPLETED");
		expect(states).toContain("FINISHED");
		expect(states).not.toContain("TOOL_EXECUTING");
		expect(states[states.length - 1]).toBe("FINISHED");
		expect(result.finalState).toBe("FINISHED");
		expect(result.status).toBe("completed");
	});
});

function harnessOf(fake: FakeWorkerSession, snapshots: WorkerStateSnapshot[]): WorkerHarness {
	return new WorkerHarness({
		cwd: process.cwd(),
		onStateChange: (snapshot) => snapshots.push(snapshot),
		createSession: async () => ({ session: fake as never }),
	});
}

describe("WorkerStateTracker — single tool task sequence", () => {
	test("TOOL_EXECUTING appears between generation and turn completion", async () => {
		const fake = new FakeWorkerSession({
			tools: [{ toolCallId: "t1", toolName: "read" }],
			text: "read it",
		});
		const snapshots: WorkerStateSnapshot[] = [];
		const result = await harnessOf(fake, snapshots).run(spec());

		const states = stateSequence(snapshots);
		expect(states).toContain("LLM_GENERATING");
		expect(states).toContain("TOOL_EXECUTING");
		expect(states).toContain("TURN_COMPLETED");
		expect(states[states.length - 1]).toBe("FINISHED");

		// TOOL_EXECUTING must come after generation started and before the final turn_end.
		const firstTool = states.indexOf("TOOL_EXECUTING");
		const lastFinished = states.lastIndexOf("FINISHED");
		expect(firstTool).toBeGreaterThan(-1);
		expect(firstTool).toBeLessThan(lastFinished);
		expect(fake.executedTools).toEqual(["read"]);
		expect(result.status).toBe("completed");
	});

	test("after the tool finishes the state leaves TOOL_EXECUTING", async () => {
		const fake = new FakeWorkerSession({ tools: [{ toolCallId: "t1", toolName: "read" }] });
		const snapshots: WorkerStateSnapshot[] = [];
		await harnessOf(fake, snapshots).run(spec());

		const states = stateSequence(snapshots);
		const lastTool = states.lastIndexOf("TOOL_EXECUTING");
		expect(lastTool).toBeGreaterThan(-1);
		expect(states.slice(lastTool + 1)).not.toContain("TOOL_EXECUTING");
	});
});

describe("WorkerStateTracker — parallel tool execution", () => {
	test("one tool ending while another is still pending keeps TOOL_EXECUTING", async () => {
		const fake = new FakeWorkerSession({
			parallelTools: true,
			tools: [
				{ toolCallId: "a", toolName: "read" },
				{ toolCallId: "b", toolName: "grep" },
			],
		});
		const snapshots: WorkerStateSnapshot[] = [];
		await harnessOf(fake, snapshots).run(spec());

		// `transitions` is cumulative, so read the whole history off the last snapshot.
		const transitions = snapshots[snapshots.length - 1]?.transitions ?? [];
		const stillBusy = transitions.filter((t) => t.event === "tool_execution_end:still-busy");
		expect(stillBusy).toHaveLength(1);
		expect(stillBusy[0]).toMatchObject({ from: "TOOL_EXECUTING", to: "TOOL_EXECUTING" });

		const idleEnd = transitions.filter((t) => t.event === "tool_execution_end:idle");
		expect(idleEnd.length).toBeGreaterThanOrEqual(1);
		expect(fake.executedTools).toEqual(["read", "grep"]);
	});
});
