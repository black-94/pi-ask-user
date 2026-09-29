import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
	createPiHost,
	registerAskUserUITool,
	type AskUserUIDetails,
	type RegisterAskUserUIOptions,
} from "../src/index.ts";
import { askUser } from "../src/core.ts";
import { AppendixRegistry } from "../src/output.ts";

const identityTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	strikethrough: (text: string) => text,
	inverse: (text: string) => text,
};

function harness(registry: AppendixRegistry, options: RegisterAskUserUIOptions = {}) {
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	let tool: Record<string, unknown> | undefined;
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		registerTool: (definition: Record<string, unknown>) => {
			tool = definition;
		},
	} as unknown as ExtensionAPI;
	// An empty env by default: the tests must not depend on the real environment.
	const registerOptions: RegisterAskUserUIOptions = { registry, env: options.env ?? {} };
	if (options.mode !== undefined) registerOptions.mode = options.mode;
	registerAskUserUITool(pi, registerOptions);
	assert.ok(tool, "tool must be registered");
	return { tool, handlers };
}

interface FakeTool {
	name: string;
	executionMode?: string;
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

test("registers AskUserUI as a sequential tool", () => {
	const { tool } = harness(new AppendixRegistry());
	const definition = tool as unknown as FakeTool;
	assert.equal(definition.name, "AskUserUI");
	assert.equal(definition.executionMode, "sequential");
});

test("text mode takes the text route, then message_end appends it after the answer", async () => {
	const registry = new AppendixRegistry();
	const { tool, handlers } = harness(registry, { mode: "text" });

	const result = await (tool as unknown as FakeTool).execute("call-1", PARAMS, undefined, undefined, noUICtx("json"));
	assert.equal(result.details.route, "text");
	assert.equal(result.details.status, "deferred");
	assert.equal(result.details.deferred, true);
	assert.match(result.content[0]!.text, /不要自行回答/);
	assert.equal(registry.hasPending(), true);

	const messageEnd = handlers.get("message_end")?.[0]!;
	const event = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "All set." }] } };
	const replaced = (await messageEnd(event, noUICtx("json"))) as { message?: { content: Array<{ text?: string }> } };
	assert.ok(replaced?.message);
	// The appendix is appended AFTER the model's own answer, in order.
	assert.equal(replaced!.message!.content.length, 2);
	assert.equal(replaced!.message!.content[0]!.text, "All set.");
	assert.match(replaced!.message!.content[1]!.text ?? "", /自由输入/);
});

test("the appendix is held back while an assistant message still has tool calls", async () => {
	const registry = new AppendixRegistry();
	const { tool, handlers } = harness(registry, { mode: "text" });
	await (tool as unknown as FakeTool).execute("call-1b", PARAMS, undefined, undefined, noUICtx("print"));

	const messageEnd = handlers.get("message_end")?.[0]!;
	const withToolCall = {
		type: "message_end",
		message: { role: "assistant", content: [{ type: "toolCall", id: "t", name: "AskUserUI", arguments: {} }] },
	};
	assert.equal(await messageEnd(withToolCall, noUICtx("print")), undefined);
	assert.equal(registry.hasPending(), true);

	const finals = {
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text: "Here you go." }] },
	};
	const replaced = (await messageEnd(finals, noUICtx("print"))) as { message?: { content: Array<{ text?: string }> } };
	assert.equal(replaced!.message!.content[0]!.text, "Here you go.");
	assert.match(replaced!.message!.content[1]!.text ?? "", /自由输入/);
});

test("json/print with the default native mode is an actionable error, not a fallback to text", async () => {
	const registry = new AppendixRegistry();
	const { tool } = harness(registry);
	const result = await (tool as unknown as FakeTool).execute("call-2", PARAMS, undefined, undefined, noUICtx("json"));
	assert.equal(result.details.route, "native");
	assert.equal(result.details.status, "error");
	assert.equal(result.details.error?.code, "unsupported_mode");
	assert.equal(result.details.deferred, false);
	assert.equal(result.details.plainText, undefined, "no text may be delivered on a refused route");
	assert.equal(registry.hasPending(), false);
	// Actionable: names the requirement and the alternative.
	assert.match(result.content[0]!.text, /unsupported_mode/);
	assert.match(result.content[0]!.text, /ctx\.ui\.input/);
	assert.match(result.content[0]!.text, /text/);
});

test("rpc with a dialog-capable client uses native dialogs by default", async () => {
	const registry = new AppendixRegistry();
	const { tool } = harness(registry);
	const ctx = rpcCtx(async () => "2");
	const result = await (tool as unknown as FakeTool).execute("call-2b", PARAMS, undefined, undefined, ctx);
	assert.equal(result.details.route, "native");
	assert.equal(result.details.status, "answered");
	assert.match(result.content[0]!.text, /prod/);
});

test("a nonresponsive rpc client yields an actionable timeout, never an unsupported guess", async () => {
	const registry = new AppendixRegistry();
	const { tool } = harness(registry);
	// The client has hasUI and a callable input, but never answers.
	const ctx = rpcCtx(() => new Promise<never>(() => {}));
	const result = await (tool as unknown as FakeTool).execute("call-2c", PARAMS_FAST, undefined, undefined, ctx);
	assert.equal(result.details.route, "native");
	assert.equal(result.details.status, "timeout");
	assert.notEqual(result.details.error?.code, "unsupported_mode");
	assert.equal(result.details.plainText, undefined);
	assert.equal(registry.hasPending(), false);
	// Actionable: tells the caller what to do when the client never responds.
	assert.match(result.content[0]!.text, /超时/);
	assert.match(result.content[0]!.text, /PI_ASK_USER_UI_MODE=text/);
});

test("tui mode also defaults to native dialogs", async () => {
	const registry = new AppendixRegistry();
	const { tool } = harness(registry);
	const ctx = { mode: "tui", hasUI: true, ui: { input: async () => "2" } } as unknown as ExtensionContext;
	const result = await (tool as unknown as FakeTool).execute("call-3a", PARAMS, undefined, undefined, ctx);
	assert.equal(result.details.route, "native");
	assert.equal(result.details.status, "answered");
	assert.match(result.content[0]!.text, /prod/);
	assert.equal(registry.hasPending(), false);
});

test("createPiHost binds implementations independently of its configured route", async () => {
	const registry = new AppendixRegistry();
	// A TUI host explicitly configured for text still binds the interactive
	// implementations, so a per-call override can use them.
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: { input: async () => "2" },
	} as unknown as ExtensionContext;
	const host = createPiHost(ctx, { registry, mode: "text" });
	assert.equal(host.mode, "text");
	assert.equal(host.customUI, undefined, "no ctx.ui.custom, so no custom renderer");
	assert.ok(host.nativeDialogs, "the native runner is bound regardless of the configured route");

	const overridden = await askUser(PARAMS, { host, mode: "native" });
	assert.equal(overridden.route, "native");
	assert.equal(overridden.status, "answered");
	assert.equal(overridden.answers[0]!.selections[0], "prod");

	// Without the override the configured text route is used.
	const configured = await askUser(PARAMS, { host });
	assert.equal(configured.route, "text");
	assert.equal(configured.status, "deferred");
});

test("a per-call mode overrides an invalid createPiHost configuration", async () => {
	const registry = new AppendixRegistry();
	const ctx = { mode: "tui", hasUI: true, ui: { input: async () => "2" } } as unknown as ExtensionContext;
	const host = createPiHost(ctx, { registry, env: { PI_ASK_USER_UI_MODE: "nope" } });
	assert.equal(host.mode, undefined);
	assert.equal(host.configError?.code, "invalid_config");

	const result = await askUser(PARAMS, { host, mode: "native" });
	assert.equal(result.route, "native");
	assert.equal(result.status, "answered");

	const refused = await askUser(PARAMS, { host });
	assert.equal(refused.status, "error");
	assert.equal(refused.error?.code, "invalid_config");
});

test("forcing custom outside a real Pi TUI is an actionable error", async () => {
	const registry = new AppendixRegistry();
	const { tool } = harness(registry, { mode: "custom" });
	const ctx = rpcCtx(async () => "2");
	const result = await (tool as unknown as FakeTool).execute("call-3b", PARAMS, undefined, undefined, ctx);
	assert.equal(result.details.route, "custom");
	assert.equal(result.details.status, "error");
	assert.equal(result.details.error?.code, "unsupported_mode");
	assert.match(result.content[0]!.text, /TUI/);
	assert.equal(registry.hasPending(), false);
});

test("custom mode in tui renders the real custom component", async () => {
	const registry = new AppendixRegistry();
	const { tool } = harness(registry, { mode: "custom" });
	let rendered = "";
	const ctx = {
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
					rendered = component.render(100).join("\n");
					queueMicrotask(() => component.handleInput?.("\r"));
				}),
		},
	} as unknown as ExtensionContext;

	const result = await (tool as unknown as FakeTool).execute("call-3", PARAMS, undefined, undefined, ctx);
	assert.equal(result.details.route, "custom");
	assert.equal(result.details.status, "answered");
	assert.match(rendered, new RegExp(PARAMS.questions[0]!.title));
	assert.match(result.content[0]!.text, /staging/);
	assert.equal(registry.hasPending(), false);
});

test("model parameters cannot change the mode", async () => {
	const registry = new AppendixRegistry();
	const { tool } = harness(registry, { mode: "text" });
	const ctx = rpcCtx(async () => "2");
	const spoofed = {
		...PARAMS,
		mode: "custom",
		uiMode: "custom",
		ui_mode: "native",
		route: "custom",
		capabilities: { customUI: true, nativeDialogs: true },
		nativeDialogs: true,
		customUI: true,
		PI_ASK_USER_UI_MODE: "custom",
	};
	const result = await (tool as unknown as FakeTool).execute("call-2d", spoofed, undefined, undefined, ctx);
	assert.equal(result.details.route, "text", "the forced text mode must win over any model parameter");
	assert.equal(result.details.status, "deferred");
});

test("the programmatic mode beats the environment variable", async () => {
	const registry = new AppendixRegistry();
	const { tool } = harness(registry, { mode: "native", env: { PI_ASK_USER_UI_MODE: "text" } });
	const ctx = rpcCtx(async () => "2");
	const result = await (tool as unknown as FakeTool).execute("call-2e", PARAMS, undefined, undefined, ctx);
	assert.equal(result.details.route, "native");
	assert.equal(result.details.status, "answered");
});

test("the environment variable selects the route when no mode is passed", async () => {
	const registry = new AppendixRegistry();
	const { tool } = harness(registry, { env: { PI_ASK_USER_UI_MODE: "TEXT" } });
	const result = await (tool as unknown as FakeTool).execute("call-2f", PARAMS, undefined, undefined, noUICtx("json"));
	assert.equal(result.details.route, "text");
	assert.equal(result.details.status, "deferred");
	assert.equal(registry.hasPending(), true);
});

test("an invalid environment value is an actionable invalid_config error", async () => {
	const registry = new AppendixRegistry();
	const { tool } = harness(registry, { env: { PI_ASK_USER_UI_MODE: "plain_text" } });
	const result = await (tool as unknown as FakeTool).execute("call-2g", PARAMS, undefined, undefined, noUICtx("json"));
	assert.equal(result.details.status, "error");
	assert.equal(result.details.error?.code, "invalid_config");
	assert.equal(result.details.plainText, undefined);
	assert.equal(registry.hasPending(), false);
	assert.match(result.content[0]!.text, /PI_ASK_USER_UI_MODE/);
	assert.match(result.content[0]!.text, /custom \| native \| text/);
});

test("an invalid programmatic mode is an actionable invalid_config error", async () => {
	const registry = new AppendixRegistry();
	const { tool } = harness(registry, { mode: "plain_text" as never });
	const result = await (tool as unknown as FakeTool).execute("call-2h", PARAMS, undefined, undefined, noUICtx("json"));
	assert.equal(result.details.status, "error");
	assert.equal(result.details.error?.code, "invalid_config");
	assert.match(result.content[0]!.text, /custom \| native \| text/);
});

test("invalid parameters produce a model-readable error result", async () => {
	const { tool } = harness(new AppendixRegistry(), { mode: "text" });
	const result = await (tool as unknown as FakeTool).execute(
		"call-4",
		{ questions: [] },
		undefined,
		undefined,
		noUICtx("json"),
	);
	assert.equal(result.details.status, "error");
	assert.equal(result.details.error?.code, "invalid_request");
	assert.equal(result.details.route, "text");
	assert.match(result.content[0]!.text, /参数无效/);
});

test("a stale pending questionnaire is cleared at the next user turn", async () => {
	const registry = new AppendixRegistry();
	const { tool, handlers } = harness(registry, { mode: "text" });
	await (tool as unknown as FakeTool).execute("call-5", PARAMS, undefined, undefined, noUICtx("json"));
	assert.equal(registry.hasPending(), true);

	const messageStart = handlers.get("message_start")?.[0]!;
	await messageStart({ type: "message_start", message: { role: "user", content: "hi" } }, noUICtx("json"));
	assert.equal(registry.hasPending(), false);
});
