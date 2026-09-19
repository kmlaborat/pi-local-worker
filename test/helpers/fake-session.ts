import type { AgentSessionEvent, AgentSessionEventListener, ToolCallEventResult } from "@earendil-works/pi-coding-agent";

import type { WorkerSession } from "../../src/worker-harness.ts";

export interface FakeToolCall {
	toolCallId: string;
	toolName: string;
	/**
	 * If set, the tool parks here mid-execution (after `tool_execution_start`
	 * and `tool_execution_update`, before the id is dropped from
	 * `pendingToolCalls`), modelling a long-running tool.
	 */
	holdOpen?: Promise<void>;
}

export interface FakeSessionOptions {
	/** stopReason reported on the final assistant message. */
	stopReason?: string;
	/** text of the final assistant message. */
	text?: string;
	/** value exposed as `session.state.errorMessage`. */
	errorMessage?: string;
	/** set false to simulate a run that never reaches `agent_settled`. */
	emitSettled?: boolean;
	/** set false to simulate a run that never emits `agent_end`. */
	emitAgentEnd?: boolean;
	/** set false so no assistant message is produced at all. */
	emitAssistantMessage?: boolean;
	/** tool calls the Worker performs during its first turn. */
	tools?: FakeToolCall[];
	/** emit all `tool_execution_start` events before any end event (pi parallel mode). */
	parallelTools?: boolean;
	/**
	 * Mirror of pi's `agent.beforeToolCall` -> extension runner `tool_call` hop.
	 * Called after `tool_execution_start` and before the tool "executes", exactly
	 * like the real chain verified in agent-loop.ts `prepareToolCall`.
	 */
	toolCallHandler?: (event: { toolName: string; toolCallId: string; input: Record<string, unknown> }) =>
		| ToolCallEventResult
		| undefined
		| Promise<ToolCallEventResult | undefined>;
	/** if provided, `prompt()` awaits this before doing anything. */
	gate?: Promise<void>;
	/**
	 * If provided, `prompt()` pauses here right after the first assistant
	 * generation activity, leaving the Worker parked in LLM_GENERATING so tests
	 * can advance a virtual clock past the idle threshold.
	 */
	gateAfterLlmActivity?: Promise<void>;
	/**
	 * Extra park points. Each gate parks the Worker again; resolving it emits a
	 * fresh assistant `message_update`, which clears the Step 4 stall episode and
	 * lets a later quiet period become a *new* episode. Lets tests drive multiple
	 * stall episodes against one run without wall-clock sleeps.
	 */
	parkGates?: Promise<void>[];
	/**
	 * When true, `abort()` records the call but does NOT settle the session,
	 * modelling a non-cooperative AgentSession (Step 6 §13).
	 */
	nonCooperativeAbort?: boolean;
	/** If set, `steer()` rejects with this (Step 5 §16). */
	steerError?: Error;
	/** If set, `sendUserMessage()` rejects with this (Step 5 §16). */
	sendUserMessageError?: Error;
	/**
	 * If set, `prompt()` emits nothing and returns immediately, leaving the
	 * session idle — models a Worker that never got going.
	 */
	emptyPrompt?: boolean;
	/** if set, `prompt()` throws this instead of running. */
	promptError?: Error;
}

/**
 * Stand-in for the parts of pi's `AgentSession` the harness uses.
 *
 * It replays the event order observed in pi's real loop
 * (agent_start -> turn_start -> user msg -> assistant msg -> tool batch ->
 * turn_end -> agent_end -> agent_settled) and updates `pendingToolCalls`
 * *before* notifying listeners, matching `Agent.processEvents`.
 *
 * `test/api-conformance.test.ts` proves the real `AgentSession` satisfies the
 * same `WorkerSession` surface, so this fake cannot drift silently.
 */
export class FakeWorkerSession implements WorkerSession {
	public state: {
		errorMessage?: string;
		pendingToolCalls: ReadonlySet<string>;
	};
	public messages: readonly unknown[] = [];
	public readonly promptedTexts: string[] = [];
	public readonly emittedEvents: string[] = [];
	/** Tools that actually ran (passed the tool_call veto). */
	public readonly executedTools: string[] = [];
	/** Tools blocked by the tool_call veto before execution. */
	public readonly blockedTools: string[] = [];
	public disposeCount = 0;
	public abortCount = 0;
	/**
	 * Intervention-call spies. Step 4 must never touch these. They exist on the
	 * fake so a test can prove the watchdog took no action even while it had a
	 * Worker it could theoretically have poked.
	 */
	/**
	 * Intervention-call counters. Step 4 must never touch these; Step 5 must touch
	 * them only through the steering controller.
	 */
	public steerCalls = 0;
	public sendUserMessageCalls = 0;
	/** Recorded `steer()` invocations: `[text]`. */
	public readonly steerArgs: Array<[string]> = [];
	/** Recorded `sendUserMessage()` invocations: `[text, options?]`. */
	public readonly sendUserMessageArgs: Array<[string, { deliverAs?: "steer" | "followUp" }?]> = [];

	private listeners: AgentSessionEventListener[] = [];
	private idle = true;
	/**
	 * Mirrors pi's `session.isStreaming`. Driven by the scripted prompt so tests
	 * can assert the harness reads the real native signal rather than guessing.
	 */
	public streaming = false;
	private idleWaiters: Array<() => void> = [];
	private pending: Set<string> = new Set();

	public constructor(private readonly options: FakeSessionOptions = {}) {
		this.state = {
			errorMessage: options.errorMessage,
			pendingToolCalls: this.pending,
		};
	}

	public subscribe(listener: AgentSessionEventListener): () => void {
		this.listeners.push(listener);
		return () => {
			const index = this.listeners.indexOf(listener);
			if (index !== -1) this.listeners.splice(index, 1);
		};
	}

	public async prompt(text: string): Promise<void> {
		this.promptedTexts.push(text);
		this.idle = false;
		this.streaming = true;

		try {
			if (this.options.gate) {
				await this.options.gate;
			}
			if (this.options.promptError) {
				throw this.options.promptError;
			}
			await this.replay();
		} finally {
			this.streaming = false;
			this.setIdle();
		}
	}

	public getLastAssistantText(): string | undefined {
		for (let i = this.messages.length - 1; i >= 0; i--) {
			const message = this.messages[i] as { role?: string; content?: Array<{ type: string; text?: string }> };
			if (message?.role !== "assistant") continue;
			const text = (message.content ?? [])
				.filter((part) => part.type === "text")
				.map((part) => part.text ?? "")
				.join("");
			if (text.trim().length > 0) return text.trim();
		}
		return undefined;
	}

	public async waitForIdle(): Promise<void> {
		if (this.idle) return;
		await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
	}

	public async abort(): Promise<void> {
		this.abortCount += 1;
		if (this.options.nonCooperativeAbort) {
			// Non-cooperative: the request is acknowledged but the session stays
			// streaming and never settles.
			return;
		}
		this.setIdle();
	}

	public dispose(): void {
		this.disposeCount += 1;
	}

	/**
	 * Mirrors pi `AgentSession.isStreaming`.
	 */
	public get isStreaming(): boolean {
		return this.streaming;
	}

	/** Records the call; throws when `steerError` is set (Step 5 §16 tests). */
	public async steer(text: string): Promise<void> {
		this.steerCalls += 1;
		this.steerArgs.push([text]);
		if (this.options.steerError) {
			throw this.options.steerError;
		}
	}

	/** Records the call; throws when `sendUserMessageError` is set. */
	public async sendUserMessage(
		text: string,
		options?: { deliverAs?: "steer" | "followUp" },
	): Promise<void> {
		this.sendUserMessageCalls += 1;
		this.sendUserMessageArgs.push([text, options]);
		if (this.options.sendUserMessageError) {
			throw this.options.sendUserMessageError;
		}
	}

	private async replay(): Promise<void> {
		const tools = this.options.tools ?? [];
		const hasTools = tools.length > 0;
		const emitAssistant = this.options.emitAssistantMessage !== false;
		const collected: unknown[] = [];

		const userMessage = { role: "user", content: [{ type: "text", text: "task prompt" }], timestamp: 1 };
		const toolCallMessage = {
			role: "assistant",
			stopReason: hasTools ? "toolUse" : (this.options.stopReason ?? "stop"),
			content: hasTools
				? tools.map((t) => ({ type: "toolCall", id: t.toolCallId, name: t.toolName, arguments: {} }))
				: [{ type: "text", text: this.options.text ?? "worker finished the task" }],
			timestamp: 2,
		};

		this.emit({ type: "agent_start" });
		this.emit({ type: "turn_start" });
		this.emit({ type: "message_start", message: userMessage });
		this.emit({ type: "message_end", message: userMessage });
		collected.push(userMessage);

		if (emitAssistant) {
			this.emit({ type: "message_start", message: toolCallMessage });
			this.emit({ type: "message_update", message: toolCallMessage });
			// Park here with the tracker in LLM_GENERATING so a virtual clock can
			// be advanced past the idle threshold.
			if (this.options.gateAfterLlmActivity) {
				await this.options.gateAfterLlmActivity;
			}
			// Each extra gate parks the Worker again; resolving it emits a fresh
			// assistant activity, clearing the current stall episode so a later
			// quiet period becomes a new one.
			for (const gate of this.options.parkGates ?? []) {
				// Activity first, then park: the update clears the current Step 4
				// stall episode so the next quiet period is a *new* episode.
				this.emit({ type: "message_update", message: toolCallMessage });
				await gate;
			}
			this.emit({ type: "message_end", message: toolCallMessage });
			collected.push(toolCallMessage);
		}

		if (hasTools) {
			if (this.options.parallelTools) {
				for (const tool of tools) {
					this.addPending(tool.toolCallId);
					this.emit({
						type: "tool_execution_start",
						toolCallId: tool.toolCallId,
						toolName: tool.toolName,
						args: {},
					});
				}
				for (const tool of tools) {
					await this.runTool(tool);
				}
			} else {
				for (const tool of tools) {
					this.addPending(tool.toolCallId);
					this.emit({
						type: "tool_execution_start",
						toolCallId: tool.toolCallId,
						toolName: tool.toolName,
						args: {},
					});
					await this.runTool(tool);
				}
			}

			const toolResultMessage = {
				role: "toolResult",
				toolCallId: tools[0]!.toolCallId,
				toolName: tools[0]!.toolName,
				content: [{ type: "text", text: "tool output" }],
				isError: false,
				timestamp: 3,
			};
			this.emit({ type: "message_start", message: toolResultMessage });
			this.emit({ type: "message_end", message: toolResultMessage });
			collected.push(toolResultMessage);
		}

		if (emitAssistant) {
			this.emit({ type: "turn_end", message: toolCallMessage, toolResults: [] });

			if (hasTools) {
				const finalMessage = {
					role: "assistant",
					stopReason: this.options.stopReason ?? "stop",
					content: [{ type: "text", text: this.options.text ?? "worker finished the task" }],
					timestamp: 4,
				};
				this.emit({ type: "turn_start" });
				this.emit({ type: "message_start", message: finalMessage });
				this.emit({ type: "message_update", message: finalMessage });
				this.emit({ type: "message_end", message: finalMessage });
				this.emit({ type: "turn_end", message: finalMessage, toolResults: [] });
				collected.push(finalMessage);
			}
		}

		this.messages = collected;

		if (this.options.emitAgentEnd !== false) {
			this.emit({ type: "agent_end", messages: collected, willRetry: false });
		}
		if (this.options.emitSettled !== false) {
			this.emit({ type: "agent_settled" });
		}
	}

	/**
	 * Mirror of the veto-then-execute ordering in pi's `prepareToolCall`:
	 * `tool_execution_start` has already fired, the `tool_call` hook runs now,
	 * and a blocked tool produces an error result rather than executing.
	 */
	private async runTool(tool: FakeToolCall): Promise<void> {
		const decision = this.options.toolCallHandler
			? await this.options.toolCallHandler({ toolName: tool.toolName, toolCallId: tool.toolCallId, input: {} })
			: undefined;

		// pi updates `pendingToolCalls` before notifying listeners
		// (Agent.processEvents), so the id is dropped before `tool_execution_end`
		// reaches the tracker.
		if (decision?.block) {
			this.blockedTools.push(tool.toolName);
			this.removePending(tool.toolCallId);
			this.emit({
				type: "tool_execution_end",
				toolCallId: tool.toolCallId,
				toolName: tool.toolName,
				result: { content: [{ type: "text", text: decision.reason ?? "Blocked" }], details: {} },
				isError: true,
			});
			return;
		}

		this.executedTools.push(tool.toolName);
		this.emit({
			type: "tool_execution_update",
			toolCallId: tool.toolCallId,
			toolName: tool.toolName,
			args: {},
			partialResult: { content: [{ type: "text", text: "running" }], details: {} },
		});
		// Park with the id still in `pendingToolCalls`, so the tracker reads
		// TOOL_EXECUTING with a real in-flight tool.
		if (tool.holdOpen) {
			await tool.holdOpen;
		}
		this.removePending(tool.toolCallId);
		this.emit({
			type: "tool_execution_end",
			toolCallId: tool.toolCallId,
			toolName: tool.toolName,
			result: { content: [{ type: "text", text: "done" }], details: {} },
			isError: false,
		});
	}

	private addPending(id: string): void {
		this.pending = new Set([...this.pending, id]);
		this.state.pendingToolCalls = this.pending;
	}

	private removePending(id: string): void {
		const next = new Set(this.pending);
		next.delete(id);
		this.pending = next;
		this.state.pendingToolCalls = next;
	}

	private emit(event: Record<string, unknown>): void {
		this.emittedEvents.push(String(event.type));
		for (const listener of [...this.listeners]) {
			listener(event as unknown as AgentSessionEvent);
		}
	}

	private setIdle(): void {
		this.idle = true;
		const waiters = this.idleWaiters;
		this.idleWaiters = [];
		for (const resolve of waiters) resolve();
	}
}

/**
 * Build a `toolCallHandler` from the real boundary extension factory by running
 * it against a stub `ExtensionAPI` and capturing the registered `tool_call`
 * handler. This keeps the unit path on the real policy code rather than a copy.
 */
export function toolCallHandlerFromBoundaryExtension(
	factory: (pi: { on: (event: string, handler: (event: never) => unknown) => void }) => void,
): (event: { toolName: string; toolCallId: string; input: Record<string, unknown> }) => ToolCallEventResult | undefined {
	let captured: ((event: never) => unknown) | undefined;
	const stubPi = {
		on: (event: string, handler: (event: never) => unknown) => {
			if (event === "tool_call") captured = handler;
		},
	};
	factory(stubPi as never);
	if (!captured) {
		throw new Error("boundary extension did not register a tool_call handler");
	}
	const handler = captured as unknown as (event: {
		toolName: string;
		toolCallId: string;
		input: Record<string, unknown>;
	}) => ToolCallEventResult | undefined;
	return (event) => handler(event);
}
