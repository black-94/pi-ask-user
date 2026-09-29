import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
	ASK_ABORTED,
	ASK_ANSWERED,
	ASK_ERROR,
	ASK_TIMEOUT,
	HERDR_BLOCKED,
	createAskEventSink,
	outcomeChannel,
	type AskEventBus,
} from "../src/events.ts";
import { askUser, askUserNormalized } from "../src/core.ts";
import { createAskUserHost } from "../src/route.ts";
import { normalizeAskUserRequest } from "../src/schema.ts";
import type { AskUIOutcome, AskUserResult } from "../src/types.ts";
import { registerAskUser } from "../src/index.ts";

interface Recorded {
	channel: string;
	data: Record<string, unknown>;
}

function recordingBus(): { calls: Recorded[]; bus: AskEventBus } {
	const calls: Recorded[] = [];
	const bus: AskEventBus = {
		emit(channel, data) {
			calls.push({ channel, data: data as Record<string, unknown> });
		},
	};
	return { calls, bus };
}

function blockedEvents(calls: Recorded[]): Recorded[] {
	return calls.filter((call) => call.channel === HERDR_BLOCKED);
}

function outcomeEvents(calls: Recorded[]): Recorded[] {
	return calls.filter((call) => call.channel !== HERDR_BLOCKED);
}

// --- unit: payload shape ---

test("no usable bus yields no sink (never a fabricated bus)", () => {
	assert.equal(createAskEventSink(undefined), undefined);
	assert.equal(createAskEventSink({ emit: undefined as never }), undefined);
});

test("a UI attempt emits exactly one blocked pair and one outcome event", () => {
	const { calls, bus } = recordingBus();
	const sink = createAskEventSink(bus, "call-1")!;
	sink.waitStarted();
	const result: AskUserResult = { status: "answered", route: "custom", answers: [] };
	sink.waitEnded(result);
	assert.deepEqual(blockedEvents(calls), [
		{ channel: HERDR_BLOCKED, data: { active: true, label: "Waiting for user response", callId: "call-1" } },
		{ channel: HERDR_BLOCKED, data: { active: false, callId: "call-1" } },
	]);
	assert.deepEqual(outcomeEvents(calls), [
		{ channel: ASK_ANSWERED, data: { callId: "call-1", route: "custom", status: "answered" } },
	]);
});

test("outcome events never carry the question, answers, or free text", () => {
	const { calls, bus } = recordingBus();
	const sink = createAskEventSink(bus)!;
	sink.waitStarted();
	sink.waitEnded({
		status: "answered",
		route: "native",
		answers: [{ index: 0, id: "q1", title: "Secret?", kind: "input", selections: ["yes"], freeText: "top secret", usedDefault: false }],
	});
	for (const { data } of calls) {
		const serialized = JSON.stringify(data);
		assert.doesNotMatch(serialized, /top secret/);
		assert.doesNotMatch(serialized, /Secret\?/);
		assert.doesNotMatch(serialized, /"answers"/);
	}
});

test("aborted carries the cancellation reason, defaulting to user", () => {
	const { calls, bus } = recordingBus();
	const sink = createAskEventSink(bus, "c")!;
	sink.waitStarted();
	sink.waitEnded({ status: "aborted", route: "custom", answers: [], cancelledReason: "abort" });
	sink.waitStarted();
	sink.waitEnded({ status: "aborted", route: "custom", answers: [] });
	const aborts = calls.filter((call) => call.channel === ASK_ABORTED).map((call) => call.data.cancelledReason);
	assert.deepEqual(aborts, ["abort", "user"]);
});

test("timeout and error map to their channels; error names the code", () => {
	const { calls, bus } = recordingBus();
	const sink = createAskEventSink(bus)!
	sink.waitStarted();
	sink.waitEnded({ status: "timeout", route: "native", answers: [] });
	sink.waitStarted();
	sink.waitEnded({ status: "error", route: "custom", answers: [], error: { code: "custom_ui_failed", message: "boom" } });
	const channels = calls.map((call) => call.channel);
	assert.ok(channels.includes(ASK_TIMEOUT));
	assert.ok(channels.includes(ASK_ERROR));
	const errorEvent = calls.find((call) => call.channel === ASK_ERROR)!;
	assert.equal(errorEvent.data.errorCode, "custom_ui_failed");
	// No callId when absent.
	assert.equal("callId" in errorEvent.data, false);
});

test("outcomeChannel is the documented mapping", () => {
	assert.equal(outcomeChannel("answered"), ASK_ANSWERED);
	assert.equal(outcomeChannel("aborted"), ASK_ABORTED);
	assert.equal(outcomeChannel("timeout"), ASK_TIMEOUT);
	assert.equal(outcomeChannel("error"), ASK_ERROR);
});

test("an emission failure is swallowed and never breaks the interaction", () => {
	const sink = createAskEventSink({
		emit() {
			throw new Error("bus is broken");
		},
	})!;
	assert.doesNotThrow(() => sink.waitStarted());
	assert.doesNotThrow(() => sink.waitEnded({ status: "timeout", route: "native", answers: [] }));
});

// --- core: exactly one pair on a real UI attempt, nothing otherwise ---

function customHost(outcome: AskUIOutcome): ReturnType<typeof createAskUserHost> {
	return createAskUserHost({ name: "test", customUI: { render: async () => outcome } });
}

function answeredOutcome(): AskUIOutcome {
	return {
		kind: "submitted",
		answers: [{ index: 0, id: "q1", title: "Q", kind: "input", selections: [], freeText: "ok", usedDefault: false }],
	};
}

const REQUEST = normalizeAskUserRequest({ questions: [{ title: "Q", kind: "input" }] }).request;

test("core emits one blocked pair and the outcome for a UI attempt", async () => {
	const { calls, bus } = recordingBus();
	await askUserNormalized(REQUEST, { host: customHost(answeredOutcome()), events: createAskEventSink(bus, "x") });
	assert.equal(blockedEvents(calls).length, 2);
	assert.equal(blockedEvents(calls)[0]!.data.active, true);
	assert.equal(blockedEvents(calls)[1]!.data.active, false);
	assert.deepEqual(outcomeEvents(calls).map((call) => call.channel), [ASK_ANSWERED]);
});

test("core emits the blocked pair plus ask:timeout on timeout", async () => {
	const { calls, bus } = recordingBus();
	const host = customHost({ kind: "timeout" });
	const result = await askUserNormalized(REQUEST, { host, events: createAskEventSink(bus) });
	assert.equal(result.status, "timeout");
	assert.equal(blockedEvents(calls).length, 2);
	assert.equal(blockedEvents(calls)[1]!.data.active, false);
	assert.deepEqual(outcomeEvents(calls).map((call) => call.channel), [ASK_TIMEOUT]);
});

test("core emits the blocked pair plus ask:error when the renderer throws", async () => {
	const { calls, bus } = recordingBus();
	const host = createAskUserHost({
		name: "test",
		customUI: {
			render: async () => {
				throw new Error("render blew up");
			},
		},
	});
	const result = await askUserNormalized(REQUEST, { host, events: createAskEventSink(bus) });
	assert.equal(result.status, "error");
	assert.equal(blockedEvents(calls).length, 2);
	assert.equal(blockedEvents(calls)[1]!.data.active, false);
	assert.deepEqual(outcomeEvents(calls).map((call) => call.channel), [ASK_ERROR]);
});

test("an invalid request emits no events (no UI is attempted)", async () => {
	const { calls, bus } = recordingBus();
	const result = await askUser({ questions: [] }, { host: customHost(answeredOutcome()), events: createAskEventSink(bus) });
	assert.equal(result.status, "error");
	assert.equal(result.error?.code, "invalid_request");
	assert.deepEqual(calls, []);
});

test("an unavailable host emits no events (no UI is attempted)", async () => {
	const { calls, bus } = recordingBus();
	const host = createAskUserHost({ name: "none" });
	const result = await askUserNormalized(REQUEST, { host, events: createAskEventSink(bus) });
	assert.equal(result.status, "error");
	assert.equal(result.error?.code, "unsupported_mode");
	assert.deepEqual(calls, []);
});

test("an already-aborted call emits no events", async () => {
	const { calls, bus } = recordingBus();
	const controller = new AbortController();
	controller.abort();
	const result = await askUserNormalized(REQUEST, {
		host: customHost(answeredOutcome()),
		signal: controller.signal,
		events: createAskEventSink(bus),
	});
	assert.equal(result.status, "aborted");
	assert.deepEqual(calls, []);
});

// --- integration: the registered tool ---

type Handler = (event: unknown, ctx: unknown) => unknown;

function toolHarness() {
	const handlers = new Map<string, Handler[]>();
	const { calls, bus } = recordingBus();
	let tool: Record<string, unknown> | undefined;
	const pi = {
		on: (event: string, handler: Handler) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		registerTool: (definition: Record<string, unknown>) => {
			tool = definition;
		},
		events: bus,
	} as unknown as ExtensionAPI;
	registerAskUser(pi, { configFile: false });
	assert.ok(tool);
	return { tool: tool!, handlers, calls };
}

function startSession(handlers: Map<string, Handler[]>, ctx: ExtensionContext): void {
	for (const handler of handlers.get("session_start") ?? []) handler({ type: "session_start", reason: "startup" }, ctx);
}

const identityTheme = {
	fg: (_c: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	strikethrough: (text: string) => text,
	inverse: (text: string) => text,
};

function answeringCtx(): ExtensionContext {
	return {
		mode: "tui",
		hasUI: true,
		ui: {
			input: async () => "x",
			custom: (factory: (tui: unknown, theme: unknown, kb: unknown, done: (r: unknown) => void) => Component) =>
				new Promise((resolve) => {
					const component = factory(
						{ requestRender: () => {}, terminal: { rows: 24, columns: 100 } },
						identityTheme,
						{},
						(result: unknown) => resolve(result),
					);
					queueMicrotask(() => component.handleInput?.("\r"));
				}),
		},
	} as unknown as ExtensionContext;
}

function rpcCtx(answer: string): ExtensionContext {
	return { mode: "rpc", hasUI: true, ui: { input: async () => answer } } as unknown as ExtensionContext;
}

const TOOL_PARAMS = {
	questions: [{ title: "Q", kind: "single", options: [{ label: "a" }, { label: "b" }] }],
};

function execute(tool: Record<string, unknown>, params: unknown, id: string, ctx: ExtensionContext) {
	const definition = tool as unknown as {
		execute: (id: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: ExtensionContext) => Promise<unknown>;
	};
	return definition.execute(id, params, undefined, undefined, ctx);
}

test("the tool emits the blocked pair and ask:answered with the tool call id", async () => {
	const { tool, handlers, calls } = toolHarness();
	const ctx = answeringCtx();
	startSession(handlers, ctx);
	const result = (await execute(tool, TOOL_PARAMS, "call-42", ctx)) as { details: { status: string } };
	assert.equal(result.details.status, "answered");
	assert.deepEqual(blockedEvents(calls), [
		{ channel: HERDR_BLOCKED, data: { active: true, label: "Waiting for user response", callId: "call-42" } },
		{ channel: HERDR_BLOCKED, data: { active: false, callId: "call-42" } },
	]);
	assert.deepEqual(outcomeEvents(calls), [
		{ channel: ASK_ANSWERED, data: { callId: "call-42", route: "custom", status: "answered" } },
	]);
});

test("the tool emits ask:timeout for a silent rpc client, still exactly one pair", async () => {
	const { tool, handlers, calls } = toolHarness();
	const ctx = { mode: "rpc", hasUI: true, ui: { input: () => new Promise<never>(() => {}) } } as unknown as ExtensionContext;
	startSession(handlers, ctx);
	const result = (await execute(tool, { ...TOOL_PARAMS, timeoutPerQuestionMs: 25 }, "call-slow", ctx)) as {
		details: { status: string };
	};
	assert.equal(result.details.status, "timeout");
	assert.equal(blockedEvents(calls).length, 2);
	assert.deepEqual(outcomeEvents(calls), [{ channel: ASK_TIMEOUT, data: { callId: "call-slow", route: "native", status: "timeout" } }]);
});

test("the tool emits nothing for an invalid questionnaire or a refused host", async () => {
	const valid = toolHarness();
	startSession(valid.handlers, rpcCtx("1"));
	await execute(valid.tool, { questions: [] }, "call-invalid", rpcCtx("1"));
	assert.deepEqual(valid.calls, []);

	const unsupported = toolHarness();
	startSession(unsupported.handlers, { mode: "json", hasUI: false, ui: {} } as unknown as ExtensionContext);
	await execute(unsupported.tool, TOOL_PARAMS, "call-unavailable", { mode: "json", hasUI: false, ui: {} } as unknown as ExtensionContext);
	assert.deepEqual(unsupported.calls, []);
});
