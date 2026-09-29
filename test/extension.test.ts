import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
	createPiHost,
	registerAskUser,
	askUserSupport,
	type AskUserToolDetails,
	type RegisterAskUserOptions,
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

function harness(options: RegisterAskUserOptions = {}) {
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
	// `configFile: false` keeps tests hermetic: they never read the developer's
	// real ~/.pi/ask-user/config.json. Tests that exercise the file pass
	// an explicit `configFile` to override.
	registerAskUser(pi, { configFile: false, ...options });
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
	) => Promise<{ content: Array<{ type: string; text: string }>; details: AskUserToolDetails }>;
}

const PARAMS = {
	questions: [{ title: "Deploy where?", kind: "single", options: [{ label: "staging" }, { label: "prod" }] }],
};

/** Same question, but with a deadline short enough to test timeouts. */
const PARAMS_FAST = { ...PARAMS, timeoutPerQuestionMs: 30 };

/** Ordinary-text fallback advice, offered only for UI-unavailable/failure results. */
const FALLBACK_ADVICE = /ask the user the question yourself in ordinary text/i;

function noUICtx(mode: "json" | "print"): ExtensionContext {
	return { mode, hasUI: false, ui: {} } as unknown as ExtensionContext;
}

/** RPC reports hasUI: true and exposes a callable input dialog. */
function rpcCtx(input: (prompt: string) => Promise<string | undefined>): ExtensionContext {
	return { mode: "rpc", hasUI: true, ui: { input } } as unknown as ExtensionContext;
}

/** A TUI context that exposes both a callable input dialog and a custom renderer. */
function tuiWithCustom(onRender?: (rendered: string) => void, key = "\r"): ExtensionContext {
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
					queueMicrotask(() => component.handleInput?.(key));
				}),
		},
	} as unknown as ExtensionContext;
}

/** A TUI context whose custom renderer resolves a fixed outcome (no real component). */
function tuiCustomOutcome(outcome: unknown): ExtensionContext {
	return {
		mode: "tui",
		hasUI: true,
		ui: {
			input: async () => "2",
			custom: async () => outcome,
		},
	} as unknown as ExtensionContext;
}

function execute(tool: Record<string, unknown>, params: unknown, ctx: ExtensionContext, id = "call") {
	return (tool as unknown as FakeTool).execute(id, params, undefined, undefined, ctx);
}

test("registers ask_user as a sequential tool and subscribes to the session lifecycle", () => {
	const { tool, handlers } = harness();
	const definition = tool as unknown as FakeTool;
	assert.equal(definition.name, "ask_user");
	assert.equal(definition.executionMode, "sequential");
	assert.equal(handlers.get("session_start")?.length, 1);
	assert.equal(handlers.get("session_shutdown")?.length, 1);
	const guidelines = definition.promptGuidelines?.join(" ") ?? "";
	assert.match(guidelines, FALLBACK_ADVICE, "the guidance must direct an ordinary-text question when the UI fails");
	assert.match(guidelines, /never invent an answer/i, "the guidance must forbid fabricating an answer");
	assert.doesNotMatch(
		guidelines,
		/(output|emit|print|render) the questionnaire/i,
		"the model must not be told to output the questionnaire itself",
	);
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
	assert.match(result.content[0]!.text, FALLBACK_ADVICE, "not_initialized still advises a text fallback");
});

test("json and print have no interactive route; the tool text advises an ordinary-text question", async () => {
	for (const mode of ["json", "print"] as const) {
		const { tool, handlers } = harness();
		startSession(handlers, noUICtx(mode));
		const result = await execute(tool, PARAMS, noUICtx(mode), `call-${mode}`);
		assert.equal(result.details.status, "error", `${mode}: refused, not answered`);
		assert.equal(result.details.error?.code, "unsupported_mode", `${mode}: actionable code`);
		assert.equal(result.details.route, undefined, `${mode}: no route is fabricated`);
		assert.deepEqual(result.details.answers, [], `${mode}: no answers`);
		assert.match(result.content[0]!.text, /unsupported_mode/, `${mode}: names the failure`);
		assert.match(result.content[0]!.text, /could not complete the request/i, `${mode}: truthful UI-failure wording`);
		assert.match(result.content[0]!.text, FALLBACK_ADVICE, `${mode}: advises an ordinary-text question`);
		assert.match(result.content[0]!.text, /Deploy where\?/, `${mode}: includes the question content`);
		assert.match(result.content[0]!.text, /staging/, `${mode}: includes the options`);
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
		assert.match(result.content[0]!.text, FALLBACK_ADVICE, `${mode}: advises an ordinary-text fallback`);
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
	assert.match(result.content[0]!.text, FALLBACK_ADVICE, "invalid_config advises a text fallback");
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
	assert.match(result.content[0]!.text, /before the deadline/i);
	assert.doesNotMatch(result.content[0]!.text, FALLBACK_ADVICE, "a timeout must not invite a text re-ask");
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

test("unexpected parameter keys are rejected, never routed", async () => {
	const { tool, handlers } = harness();
	const ctx = rpcCtx(async () => "2");
	startSession(handlers, ctx);
	for (const key of ["extra", "uiMode", "mode", "route"] as const) {
		const result = await execute(tool, { ...PARAMS, [key]: "custom" }, ctx, `call-reject-${key}`);
		assert.equal(result.details.status, "error", `${key}: rejected`);
		assert.equal(result.details.error?.code, "invalid_request", `${key}: invalid_request`);
		assert.equal(result.details.route, undefined, `${key}: no route is fabricated`);
		assert.doesNotMatch(result.content[0]!.text, FALLBACK_ADVICE, `${key}: unknown input is not a UI failure`);
	}
});

test("invalid parameters produce a model-readable error result", async () => {
	const { tool, handlers } = harness();
	startSession(handlers, noUICtx("json"));
	const result = await execute(tool, { questions: [] }, noUICtx("json"), "call-invalid");
	assert.equal(result.details.status, "error");
	assert.equal(result.details.error?.code, "invalid_request");
	assert.equal(result.details.route, undefined);
	assert.match(result.content[0]!.text, /invalid parameters/i);
	assert.doesNotMatch(result.content[0]!.text, FALLBACK_ADVICE, "an invalid questionnaire is not a UI failure");
});

test("an empty submitted answer is a non-UI failure with no text fallback or retry advice", async () => {
	const { tool, handlers } = harness({ mode: "custom" });
	const ctx = tuiCustomOutcome({
		kind: "submitted",
		answers: [{ index: 0, id: "q1", title: "Deploy where?", kind: "single", selections: [], usedDefault: false }],
	});
	startSession(handlers, ctx);
	const result = await execute(tool, PARAMS, ctx, "call-empty");
	assert.equal(result.details.status, "error");
	assert.equal(result.details.error?.code, "empty_answer");
	assert.doesNotMatch(result.content[0]!.text, FALLBACK_ADVICE, "empty_answer is not a UI failure");
	assert.doesNotMatch(result.content[0]!.text, /fix the request/i, "no retry advice for a non-UI failure");
	assert.match(result.content[0]!.text, /report the failure/i);
});

test("a custom render failure is reported as custom_ui_failed with a text fallback", async () => {
	const { tool, handlers } = harness({ mode: "custom" });
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			input: async () => "2",
			custom: async () => {
				throw new Error("render blew up");
			},
		},
	} as unknown as ExtensionContext;
	startSession(handlers, ctx);
	const result = await execute(tool, PARAMS, ctx, "call-custom-fail");
	assert.equal(result.details.status, "error");
	assert.equal(result.details.error?.code, "custom_ui_failed");
	assert.equal(result.details.route, "custom");
	assert.match(result.content[0]!.text, FALLBACK_ADVICE);
});

test("a native dialog failure is reported as native_ui_failed with a text fallback", async () => {
	const { tool, handlers } = harness();
	const ctx = rpcCtx(async () => {
		throw new Error("dialog blew up");
	});
	startSession(handlers, ctx);
	const result = await execute(tool, PARAMS, ctx, "call-native-fail");
	assert.equal(result.details.status, "error");
	assert.equal(result.details.error?.code, "native_ui_failed");
	assert.equal(result.details.route, "native");
	assert.match(result.content[0]!.text, FALLBACK_ADVICE);
});

test("a caller abort is reported with no text fallback", async () => {
	const { tool, handlers } = harness();
	const ctx = rpcCtx(async () => "2");
	startSession(handlers, ctx);
	const controller = new AbortController();
	controller.abort();
	const result = await (tool as unknown as FakeTool).execute("call-abort", PARAMS, controller.signal, undefined, ctx);
	assert.equal(result.details.status, "aborted");
	assert.equal(result.details.error, undefined);
	assert.match(result.content[0]!.text, /aborted/i);
	assert.doesNotMatch(result.content[0]!.text, FALLBACK_ADVICE, "an abort must not invite a text re-ask");
});

test("a user dismissal is reported as aborted with no text fallback", async () => {
	const { tool, handlers } = harness();
	const ctx = tuiWithCustom(undefined, "\x1b"); // Escape dismisses the custom UI
	startSession(handlers, ctx);
	const result = await execute(tool, PARAMS, ctx, "call-dismiss");
	assert.equal(result.details.status, "aborted");
	assert.equal(result.details.error, undefined);
	assert.match(result.content[0]!.text, /dismissed/i);
	assert.doesNotMatch(result.content[0]!.text, FALLBACK_ADVICE, "a dismissal must not invite a text re-ask");
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
	const noUI = createPiHost(noUICtx("json"), { configFile: false });
	assert.equal(askUserSupport(noUI).status, "no_available_ui");

	const nativeOnly = createPiHost(rpcCtx(async () => "2"), { configFile: false });
	const nativeSupport = askUserSupport(nativeOnly);
	assert.equal(nativeSupport.status, "available");
	if (nativeSupport.status === "available") {
		assert.equal(nativeSupport.route, "native");
		assert.equal(nativeSupport.source, "probed");
	}

	const both = createPiHost(tuiWithCustom(), { configFile: false });
	const bothSupport = askUserSupport(both);
	assert.equal(bothSupport.status, "available");
	if (bothSupport.status === "available") {
		assert.equal(bothSupport.route, "custom");
		assert.deepEqual(bothSupport.available, ["custom", "native"]);
	}

	const configuredMismatch = createPiHost(rpcCtx(async () => "2"), { mode: "custom", configFile: false });
	assert.equal(configuredMismatch.support.status, "configured_unavailable");
});

test("a host created outside the extension answers with the usual semantics", async () => {
	const host = createPiHost(rpcCtx(async () => "2"), { configFile: false });
	const result = await askUser(PARAMS, { host });
	assert.equal(result.route, "native");
	assert.equal(result.status, "answered");
	assert.equal(result.answers[0]!.selections[0], "prod");
});

// --- user config file integration ---

const configDir = mkdtempSync(join(tmpdir(), "pi-ask-user-ext-"));
let configCounter = 0;
function configFile(value: unknown, raw = false): string {
	const path = join(configDir, `settings-${configCounter++}.json`);
	writeFileSync(path, raw ? String(value) : JSON.stringify(value), "utf8");
	return path;
}
test.after(() => rmSync(configDir, { recursive: true, force: true }));

test("a config-file mode drives the session route and is read once per session", async () => {
	const path = configFile({ mode: "native" });
	const { tool, handlers } = harness({ configFile: path });
	// A TUI context would probe to custom; the file forces native.
	startSession(handlers, tuiWithCustom());
	const first = await execute(tool, PARAMS, tuiWithCustom(), "call-config-one");
	assert.equal(first.details.route, "native");
	assert.equal(first.details.status, "answered");

	// Rewriting the file does not change the already-created session host.
	writeFileSync(path, JSON.stringify({ mode: "custom" }), "utf8");
	const second = await execute(tool, PARAMS, tuiWithCustom(), "call-config-two");
	assert.equal(second.details.route, "native");
});

test("an explicit programmatic mode beats the config file", async () => {
	const path = configFile({ mode: "native" });
	const { tool, handlers } = harness({ configFile: path, mode: "custom" });
	startSession(handlers, tuiWithCustom());
	const result = await execute(tool, PARAMS, tuiWithCustom(), "call-config-override");
	assert.equal(result.details.route, "custom");
	assert.equal(result.details.status, "answered");
});

test("an invalid config file refuses every call with invalid_config, never a fallback", async () => {
	const path = configFile("{ not json", true);
	const { tool, handlers } = harness({ configFile: path });
	startSession(handlers, rpcCtx(async () => "2"));
	const result = await execute(tool, PARAMS, rpcCtx(async () => "2"), "call-config-invalid");
	assert.equal(result.details.status, "error");
	assert.equal(result.details.error?.code, "invalid_config");
	assert.equal(result.details.route, undefined, "no route is fabricated");
	assert.match(result.content[0]!.text, /not valid JSON/);
	assert.match(result.content[0]!.text, FALLBACK_ADVICE, "an unusable config advises a text fallback");
});
