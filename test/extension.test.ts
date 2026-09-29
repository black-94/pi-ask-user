import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
	createPiHost,
	registerAskUserUITool,
	askUserSupport,
	type AskUserUIDetails,
	type RegisterAskUserUIOptions,
} from "../src/index.ts";
import { askUser } from "../src/core.ts";

const identityTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	strikethrough: (text: string) => text,
	inverse: (text: string) => text,
};

type Handler = (event: unknown, ctx: unknown) => unknown;

function harness(options: RegisterAskUserUIOptions = {}) {
	const handlers = new Map<string, Handler[]>();
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
	} as unknown as ExtensionAPI;
	registerAskUserUITool(pi, options);
	assert.ok(tool, "tool must be registered");
	return { tool, handlers };
}

/** Fire the extension's session_start handler(s), as Pi does at session start. */
function startSession(handlers: Map<string, Handler[]>, ctx: ExtensionContext, reason = "startup"): void {
	for (const handler of handlers.get("session_start") ?? []) handler({ type: "session_start", reason }, ctx);
}

/** Fire the extension's session_shutdown handler(s). */
function shutdownSession(handlers: Map<string, Handler[]>, reason = "quit"): void {
	for (const handler of handlers.get("session_shutdown") ?? []) handler({ type: "session_shutdown", reason }, {});
}

interface FakeTool {
	name: string;
	executionMode?: string;
	promptGuidelines?: string[];
	execute: (
		id: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	) => Promise<{ content: Array<{ type: string; text: string }>; details: AskUserUIDetails }>;
}

const PARAMS = {
	questions: [{ title: "Deploy where?", kind: "single", options: [{ label: "staging" }, { label: "prod" }] }],
};

/** Same question, but with a deadline short enough to test timeouts. */
const PARAMS_FAST = { ...PARAMS, timeoutPerQuestionMs: 30 };

function noUICtx(mode: "json" | "print"): ExtensionContext {
	return { mode, hasUI: false, ui: {} } as unknown as ExtensionContext;
}

/** RPC reports hasUI: true and exposes a callable input dialog. */
function rpcCtx(input: (prompt: string) => Promise<string | undefined>): ExtensionContext {
	return { mode: "rpc", hasUI: true, ui: { input } } as unknown as ExtensionContext;
}

/** A TUI context that exposes both a callable input dialog and a custom renderer. */
function tuiWithCustom(onRender?: (rendered: string) => void): ExtensionContext {
	return {
		mode: "tui",
		hasUI: true,
		ui: {
			input: async () => "2",
			custom: (factory: (tui: unknown, theme: unknown, kb: unknown, done: (r: unknown) => void) => Component) =>
				new Promise((resolve) => {
					const component = factory(
						{ requestRender: () => {}, terminal: { rows: 24, columns: 100 } },
						identityTheme,
						{},
						(result: unknown) => resolve(result),
					);
					onRender?.(component.render(100).join("\n"));
					queueMicrotask(() => component.handleInput?.("\r"));
				}),
		},
	} as unknown as ExtensionContext;
}

function execute(tool: Record<string, unknown>, params: unknown, ctx: ExtensionContext, id = "call") {
	return (tool as unknown as FakeTool).execute(id, params, undefined, undefined, ctx);
}

test("registers AskUserUI as a sequential tool and subscribes to the session lifecycle", () => {
	const { tool, handlers } = harness();
	const definition = tool as unknown as FakeTool;
	assert.equal(definition.name, "AskUserUI");
	assert.equal(definition.executionMode, "sequential");
	assert.equal(handlers.get("session_start")?.length, 1);
	assert.equal(handlers.get("session_shutdown")?.length, 1);
	const guidelines = definition.promptGuidelines?.join(" ") ?? "";
	assert.match(guidelines, /unsupported_mode/, "the no-UI guidance must point at unsupported_mode");
	assert.match(guidelines, /cannot display the configured UI/i, "the model must report the host cannot display it");
	assert.match(guidelines, /do not answer the question yourself/i, "the model must not answer on the user's behalf");
	assert.match(guidelines, /retry(ing)? in a host that supports/i, "the model must suggest a supporting host");
	assert.doesNotMatch(
		guidelines,
		/(output|emit|print|render) the questionnaire/i,
		"the model must not be told to output the questionnaire itself",
	);
	assert.doesNotMatch(guidelines, /next message|in your reply/i, "an ordinary reply must not substitute for an answer");
});

test("a tool call before session_start is an explicit not_initialized error", async () => {
	const { tool } = harness();
	const result = await execute(tool, PARAMS, noUICtx("json"), "call-early");
	assert.equal(result.details.status, "error");
	assert.equal(result.details.error?.code, "not_initialized");
	assert.equal(result.details.route, undefined);
	assert.deepEqual(result.details.answers, []);
	// The honest reason, not a fabricated "no UI in this environment".
	assert.notEqual(result.details.error?.code, "unsupported_mode");
	assert.match(result.content[0]!.text, /session_start/);
});

test("json and print with no usable UI are an actionable error, not a fallback", async () => {
	for (const mode of ["json", "print"] as const) {
		const { tool, handlers } = harness();
		startSession(handlers, noUICtx(mode));
		const result = await execute(tool, PARAMS, noUICtx(mode), `call-${mode}`);
		assert.equal(result.details.status, "error", `${mode}: refused, not answered`);
		assert.equal(result.details.error?.code, "unsupported_mode", `${mode}: actionable code`);
		assert.equal(result.details.route, undefined, `${mode}: no route is fabricated`);
		assert.deepEqual(result.details.answers, [], `${mode}: no answers`);
		assert.match(result.content[0]!.text, /unsupported_mode/, `${mode}: names the failure`);
	}
});

test("json and print with an explicit custom mode are configured_unavailable", async () => {
	for (const mode of ["json", "print"] as const) {
		const { tool, handlers } = harness({ mode: "custom" });
		startSession(handlers, noUICtx(mode));
		const result = await execute(tool, PARAMS, noUICtx(mode), `call-${mode}-custom`);
		assert.equal(result.details.status, "error", `${mode}: refused`);
		assert.equal(result.details.error?.code, "unsupported_mode", `${mode}: actionable code`);
		assert.equal(result.details.route, "custom", `${mode}: names the requested route`);
		assert.deepEqual(result.details.answers, [], `${mode}: no answers`);
		assert.match(result.content[0]!.text, /no other mode will be used/i, `${mode}: states no fallback`);
	}
});

test("an invalid programmatic mode is an actionable invalid_config error", async () => {
	const { tool, handlers } = harness({ mode: "bogus" as never });
	startSession(handlers, rpcCtx(async () => "2"));
	const result = await execute(tool, PARAMS, rpcCtx(async () => "2"), "call-bad");
	assert.equal(result.details.status, "error");
	assert.equal(result.details.error?.code, "invalid_config");
	assert.equal(result.details.route, undefined);
	assert.match(result.content[0]!.text, /custom, native/);
});

test("rpc with a dialog-capable client probes to native dialogs", async () => {
	const { tool, handlers } = harness();
	startSession(handlers, rpcCtx(async () => "2"));
	const result = await execute(tool, PARAMS, rpcCtx(async () => "2"), "call-rpc");
	assert.equal(result.details.route, "native");
	assert.equal(result.details.status, "answered");
	assert.match(result.content[0]!.text, /prod/);
});

test("a nonresponsive rpc client yields an actionable timeout, never an unsupported guess", async () => {
	const { tool, handlers } = harness();
	startSession(handlers, rpcCtx(() => new Promise<never>(() => {})));
	const result = await execute(tool, PARAMS_FAST, rpcCtx(async () => "2"), "call-rpc-silent");
	assert.equal(result.details.route, "native");
	assert.equal(result.details.status, "timeout");
	assert.notEqual(result.details.error?.code, "unsupported_mode");
	assert.match(result.content[0]!.text, /timed out/i);
});

test("a tui host with only an input dialog probes to native", async () => {
	const { tool, handlers } = harness();
	const ctx = { mode: "tui", hasUI: true, ui: { input: async () => "2" } } as unknown as ExtensionContext;
	startSession(handlers, ctx);
	const result = await execute(tool, PARAMS, ctx, "call-tui-native");
	assert.equal(result.details.route, "native");
	assert.equal(result.details.status, "answered");
	assert.match(result.content[0]!.text, /prod/);
});

test("a tui host with both capabilities probes to custom (priority)", async () => {
	const { tool, handlers } = harness();
	let rendered = "";
	const ctx = tuiWithCustom((lines) => {
		rendered = lines;
	});
	startSession(handlers, ctx);
	const result = await execute(tool, PARAMS, ctx, "call-tui-both");
	assert.equal(result.details.route, "custom");
	assert.equal(result.details.status, "answered");
	assert.match(rendered, new RegExp(PARAMS.questions[0]!.title));
});

test("an explicit custom mode in tui renders the real custom component", async () => {
	const { tool, handlers } = harness({ mode: "custom" });
	let rendered = "";
	const ctx = tuiWithCustom((lines) => {
		rendered = lines;
	});
	startSession(handlers, ctx);
	const result = await execute(tool, PARAMS, ctx, "call-tui-custom");
	assert.equal(result.details.route, "custom");
	assert.equal(result.details.status, "answered");
	assert.match(rendered, new RegExp(PARAMS.questions[0]!.title));
	assert.match(result.content[0]!.text, /staging/);
});

test("forcing custom outside a real Pi TUI is a configured_unavailable error", async () => {
	const { tool, handlers } = harness({ mode: "custom" });
	const ctx = rpcCtx(async () => "2");
	startSession(handlers, ctx);
	const result = await execute(tool, PARAMS, ctx, "call-rpc-custom");
	assert.equal(result.details.route, "custom");
	assert.equal(result.details.status, "error");
	assert.equal(result.details.error?.code, "unsupported_mode");
	assert.match(result.content[0]!.text, /no other mode will be used/i);
});

test("a mode/route parameter cannot change the resolved route", async () => {
	const { tool, handlers } = harness();
	const ctx = rpcCtx(async () => "2");
	startSession(handlers, ctx);
	// `mode`/`route` are ignored on purpose and are never read for routing.
	const spoofed = {
		...PARAMS,
		mode: "custom",
		route: "custom",
	};
	const result = await execute(tool, spoofed, ctx, "call-spoofed");
	assert.equal(result.details.route, "native", "the probed route must win over any model parameter");
	assert.equal(result.details.status, "answered");
});

test("an unexpected parameter key is rejected and cannot change the resolved route", async () => {
	const { tool, handlers } = harness();
	const ctx = rpcCtx(async () => "2");
	startSession(handlers, ctx);
	const result = await execute(tool, { ...PARAMS, uiMode: "custom" }, ctx, "call-spoof-rejected");
	assert.equal(result.details.status, "error");
	assert.equal(result.details.error?.code, "invalid_request");
	assert.equal(result.details.route, undefined, "a rejected call cannot report a fabricated route");
});

test("invalid parameters produce a model-readable error result", async () => {
	const { tool, handlers } = harness();
	startSession(handlers, noUICtx("json"));
	const result = await execute(tool, { questions: [] }, noUICtx("json"), "call-invalid");
	assert.equal(result.details.status, "error");
	assert.equal(result.details.error?.code, "invalid_request");
	assert.equal(result.details.route, undefined);
	assert.match(result.content[0]!.text, /invalid parameters/i);
});

test("the host is created once at session_start and reused; later ctx changes do not re-probe", async () => {
	const { tool, handlers } = harness();
	// Session starts in RPC: the probe picks native.
	startSession(handlers, rpcCtx(async () => "2"));

	const first = await execute(tool, PARAMS, rpcCtx(async () => "2"), "call-one");
	assert.equal(first.details.route, "native");

	// A later call receives a TUI-with-custom ctx, which would probe to custom if
	// the route were re-selected. It must keep using the session's native host.
	const second = await execute(tool, PARAMS, tuiWithCustom(), "call-two");
	assert.equal(second.details.route, "native");
	assert.equal(second.details.status, "answered");

	// And a no-UI ctx must not turn the session into "unsupported" either.
	const third = await execute(tool, PARAMS, noUICtx("json"), "call-three");
	assert.equal(third.details.route, "native");
	assert.equal(third.details.status, "answered");
});

test("a session started with no usable UI stays refused even if a later call has UI", async () => {
	const { tool, handlers } = harness();
	startSession(handlers, noUICtx("json"));
	const result = await execute(tool, PARAMS, rpcCtx(async () => "2"), "call-after-no-ui");
	assert.equal(result.details.status, "error");
	assert.equal(result.details.error?.code, "unsupported_mode");
	assert.equal(result.details.route, undefined);
});

test("session_shutdown releases the host, so later calls are not_initialized", async () => {
	const { tool, handlers } = harness();
	startSession(handlers, rpcCtx(async () => "2"));
	assert.equal((await execute(tool, PARAMS, rpcCtx(async () => "2"), "call-live")).details.status, "answered");

	shutdownSession(handlers);
	const after = await execute(tool, PARAMS, rpcCtx(async () => "2"), "call-after-shutdown");
	assert.equal(after.details.status, "error");
	assert.equal(after.details.error?.code, "not_initialized");
});

test("a reload re-initialises the host from the fresh context", async () => {
	const { tool, handlers } = harness();
	startSession(handlers, noUICtx("json"));
	assert.equal((await execute(tool, PARAMS, noUICtx("json"), "call-before-reload")).details.error?.code, "unsupported_mode");

	// Pi fires session_shutdown(reload) then session_start(reload) with the new ctx.
	shutdownSession(handlers, "reload");
	startSession(handlers, rpcCtx(async () => "2"), "reload");
	const after = await execute(tool, PARAMS, rpcCtx(async () => "2"), "call-after-reload");
	assert.equal(after.details.route, "native");
	assert.equal(after.details.status, "answered");
});

test("createPiHost is public: other extensions can build a host and inspect its support", () => {
	const noUI = createPiHost(noUICtx("json"));
	assert.equal(askUserSupport(noUI).status, "no_available_ui");

	const nativeOnly = createPiHost(rpcCtx(async () => "2"));
	const nativeSupport = askUserSupport(nativeOnly);
	assert.equal(nativeSupport.status, "available");
	if (nativeSupport.status === "available") {
		assert.equal(nativeSupport.route, "native");
		assert.equal(nativeSupport.source, "probed");
	}

	const both = createPiHost(tuiWithCustom());
	const bothSupport = askUserSupport(both);
	assert.equal(bothSupport.status, "available");
	if (bothSupport.status === "available") {
		assert.equal(bothSupport.route, "custom");
		assert.deepEqual(bothSupport.available, ["custom", "native"]);
	}

	const configuredMismatch = createPiHost(rpcCtx(async () => "2"), { mode: "custom" });
	assert.equal(configuredMismatch.support.status, "configured_unavailable");
});

test("a host created outside the extension answers with the usual semantics", async () => {
	const host = createPiHost(rpcCtx(async () => "2"));
	const result = await askUser(PARAMS, { host });
	assert.equal(result.route, "native");
	assert.equal(result.status, "answered");
	assert.equal(result.answers[0]!.selections[0], "prod");
});
