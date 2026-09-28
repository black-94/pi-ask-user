import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { registerAskUserUITool, type AskUserUIDetails, type PiCapabilityDeclaration } from "../src/index.ts";
import { AppendixRegistry } from "../src/output.ts";

const identityTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	strikethrough: (text: string) => text,
	inverse: (text: string) => text,
};

function harness(registry: AppendixRegistry, capabilities?: PiCapabilityDeclaration) {
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
	registerAskUserUITool(pi, { registry, ...(capabilities ? { capabilities } : {}) });
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

test("registers AskUserUI as a sequential tool", () => {
	const { tool } = harness(new AppendixRegistry());
	const definition = tool as unknown as FakeTool;
	assert.equal(definition.name, "AskUserUI");
	assert.equal(definition.executionMode, "sequential");
});

test("json mode takes the plain-text route, then message_end appends it after the answer", async () => {
	const registry = new AppendixRegistry();
	const { tool, handlers } = harness(registry);
	const ctx = { mode: "json", hasUI: false, ui: {} } as unknown as ExtensionContext;

	const result = await (tool as unknown as FakeTool).execute("call-1", PARAMS, undefined, undefined, ctx);
	assert.equal(result.details.route, "plain_text");
	assert.equal(result.details.status, "deferred");
	assert.equal(result.details.deferred, true);
	assert.match(result.content[0]!.text, /不要自行回答/);
	assert.equal(registry.hasPending(), true);

	const messageEnd = handlers.get("message_end")?.[0]!;
	const event = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "All set." }] } };
	const replaced = (await messageEnd(event, ctx)) as { message?: { content: Array<{ text?: string }> } };
	assert.ok(replaced?.message);
	// The appendix is appended AFTER the model's own answer, in order.
	assert.equal(replaced!.message!.content.length, 2);
	assert.equal(replaced!.message!.content[0]!.text, "All set.");
	assert.match(replaced!.message!.content[1]!.text ?? "", /自由输入/);
});

test("the appendix is held back while an assistant message still has tool calls", async () => {
	const registry = new AppendixRegistry();
	const { tool, handlers } = harness(registry);
	const ctx = { mode: "print", hasUI: false, ui: {} } as unknown as ExtensionContext;
	await (tool as unknown as FakeTool).execute("call-1b", PARAMS, undefined, undefined, ctx);

	const messageEnd = handlers.get("message_end")?.[0]!;
	const withToolCall = {
		type: "message_end",
		message: { role: "assistant", content: [{ type: "toolCall", id: "t", name: "AskUserUI", arguments: {} }] },
	};
	assert.equal(await messageEnd(withToolCall, ctx), undefined);
	assert.equal(registry.hasPending(), true);

	const finals = {
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text: "Here you go." }] },
	};
	const replaced = (await messageEnd(finals, ctx)) as { message?: { content: Array<{ text?: string }> } };
	assert.equal(replaced!.message!.content[0]!.text, "Here you go.");
	assert.match(replaced!.message!.content[1]!.text ?? "", /自由输入/);
});

test("rpc with hasUI but no declaration takes the plain-text route", async () => {
	const registry = new AppendixRegistry();
	const { tool } = harness(registry);
	const ctx = { mode: "rpc", hasUI: true, ui: { input: async () => "2" } } as unknown as ExtensionContext;
	const result = await (tool as unknown as FakeTool).execute("call-2", PARAMS, undefined, undefined, ctx);
	assert.equal(result.details.route, "plain_text");
	assert.equal(result.details.deferred, true);
});

test("rpc with an explicit nativeDialogs declaration uses native dialogs", async () => {
	const registry = new AppendixRegistry();
	const { tool } = harness(registry, { nativeDialogs: true });
	const ctx = { mode: "rpc", hasUI: true, ui: { input: async () => "2" } } as unknown as ExtensionContext;
	const result = await (tool as unknown as FakeTool).execute("call-2b", PARAMS, undefined, undefined, ctx);
	assert.equal(result.details.route, "native");
	assert.equal(result.details.status, "answered");
	assert.match(result.content[0]!.text, /prod/);
});

test("nativeDialogs cannot be declared where it cannot run (json hasUI=false)", async () => {
	const registry = new AppendixRegistry();
	const { tool } = harness(registry, { nativeDialogs: true });
	const ctx = { mode: "json", hasUI: false, ui: {} } as unknown as ExtensionContext;
	const result = await (tool as unknown as FakeTool).execute("call-2c", PARAMS, undefined, undefined, ctx);
	assert.equal(result.details.route, "plain_text");
});

test("model parameters cannot fake a capability", async () => {
	const registry = new AppendixRegistry();
	const { tool } = harness(registry);
	const ctx = { mode: "rpc", hasUI: true, ui: { input: async () => "2" } } as unknown as ExtensionContext;
	const paramsWithFakeCapability = {
		...PARAMS,
		capabilities: { customUI: true, nativeDialogs: true },
		nativeDialogs: true,
		customUI: true,
	};
	const result = await (tool as unknown as FakeTool).execute(
		"call-2d",
		paramsWithFakeCapability,
		undefined,
		undefined,
		ctx,
	);
	assert.equal(result.details.route, "plain_text");
});

test("tui mode uses the custom component by default", async () => {
	const registry = new AppendixRegistry();
	const { tool } = harness(registry);
	const message = PARAMS.questions[0]!.title;
	let rendered = "";
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
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
	assert.match(rendered, new RegExp(message));
	assert.match(result.content[0]!.text, /staging/);
	assert.equal(registry.hasPending(), false);
});

test("invalid parameters produce a model-readable error result", async () => {
	const { tool } = harness(new AppendixRegistry());
	const ctx = { mode: "json", hasUI: false, ui: {} } as unknown as ExtensionContext;
	const result = await (tool as unknown as FakeTool).execute(
		"call-4",
		{ questions: [] },
		undefined,
		undefined,
		ctx,
	);
	assert.equal(result.details.status, "error");
	assert.equal(result.details.error?.code, "invalid_request");
	assert.match(result.content[0]!.text, /参数无效/);
});

test("a stale pending questionnaire is cleared at the next user turn", async () => {
	const registry = new AppendixRegistry();
	const { tool, handlers } = harness(registry);
	const ctx = { mode: "json", hasUI: false, ui: {} } as unknown as ExtensionContext;
	await (tool as unknown as FakeTool).execute("call-5", PARAMS, undefined, undefined, ctx);
	assert.equal(registry.hasPending(), true);

	const messageStart = handlers.get("message_start")?.[0]!;
	await messageStart({ type: "message_start", message: { role: "user", content: "hi" } }, ctx);
	assert.equal(registry.hasPending(), false);
});
