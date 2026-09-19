import {
	AgentSession,
	createAgentSession,
	type ExtensionFactory,
	type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "vitest";

import { WorkerHarness } from "../src/worker-harness.ts";
import type { WorkerHarnessConfig, WorkerSession } from "../src/worker-harness.ts";
import { BoundaryRecorder, createWorkBoundaryExtension } from "../src/work-boundary.ts";

// ---------------------------------------------------------------------------
// Compile-time conformance guards.
//
// These produce no runtime behaviour. They make `npm run typecheck` fail if pi's
// real API stops satisfying the narrow surface the harness depends on, which is
// what keeps the unit-test fake honest.
// ---------------------------------------------------------------------------

/** pi's real AgentSession must satisfy the narrow WorkerSession surface. */
const _agentSessionConformsToWorkerSession: WorkerSession = null as unknown as AgentSession;

/** The real `createAgentSession` must be a valid default for the harness seam. */
const _createAgentSessionMatchesSeam: NonNullable<WorkerHarnessConfig["createSession"]> = createAgentSession;

/** The boundary extension must be loadable as a pi inline extension factory. */
const _boundaryExtensionIsInlineExtension: InlineExtension = createWorkBoundaryExtension(
	"investigate",
	new BoundaryRecorder(),
);

/** ...and specifically as an `ExtensionFactory`, the shape `DefaultResourceLoader` accepts. */
const _boundaryExtensionIsFactory: ExtensionFactory = createWorkBoundaryExtension(
	"investigate",
	new BoundaryRecorder(),
);

void _agentSessionConformsToWorkerSession;
void _createAgentSessionMatchesSeam;
void _boundaryExtensionIsInlineExtension;
void _boundaryExtensionIsFactory;

describe("pi API conformance", () => {
	const requiredMembers = [
		"subscribe",
		"prompt",
		"waitForIdle",
		"abort",
		"dispose",
		"getLastAssistantText",
		"state",
		"messages",
		// Step 5: native steering surface.
		"steer",
		"sendUserMessage",
		"isStreaming",
	];

	test("createAgentSession is exported as a function", () => {
		expect(typeof createAgentSession).toBe("function");
	});

	test("AgentSession exposes every member the WorkerSession surface declares", () => {
		const available = new Set<string>();
		let proto: object | null = AgentSession.prototype;
		while (proto && proto !== Object.prototype) {
			for (const name of Object.getOwnPropertyNames(proto)) available.add(name);
			proto = Object.getPrototypeOf(proto) as object | null;
		}

		const missing = requiredMembers.filter((name) => !available.has(name));
		expect(missing).toEqual([]);
	});
});
