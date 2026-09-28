import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ASKUSERUI_MCP_CONTRACT,
	createMCPFinalOutputHook,
	createMCPHost,
	formatMCPDeliveredResult,
	type MCPElicitFn,
} from "../src/adapters/mcp.ts";
import { askUser } from "../src/core.ts";
import { AppendixRegistry, createPlainTextHook } from "../src/output.ts";
import { hostCapabilities } from "../src/route.ts";

const BASIC = {
	questions: [{ title: "Deploy where?", kind: "single", options: [{ label: "staging" }, { label: "prod" }] }],
	timeoutPerQuestionMs: 200,
};

test("an MCP host without elicitation declares no interactive capability", () => {
	const host = createMCPHost();
	assert.deepEqual(hostCapabilities(host), { customUI: false, nativeDialogs: false });
});

test("an MCP host with elicitation declares nativeDialogs only", () => {
	const host = createMCPHost({ elicit: async () => ({ action: "cancel" }) });
	assert.deepEqual(hostCapabilities(host), { customUI: false, nativeDialogs: true });
});

test("without elicitation the questionnaire is delivered inline as a normal fallback", async () => {
	const result = await askUser(BASIC, { host: createMCPHost() });
	assert.equal(result.route, "plain_text");
	assert.equal(result.status, "delivered");
	assert.equal(result.deferred, false);
	assert.equal(result.error, undefined, "a missing hook must not be reported as an error");
	assert.ok(result.plainText && result.plainText.includes("自由输入"));
});

test("the delivered tool-result text is a complete questionnaire with no preview and no duplicate", async () => {
	const params = {
		header: "Deployment",
		questions: [
			{
				title: "Which target?",
				kind: "single",
				prompt: "Pick one",
				options: [
					{ label: "staging", description: "internal only", preview: "SECRET PREVIEW" },
					{ label: "prod", description: "customer facing" },
				],
			},
		],
	};
	let queued = 0;
	const host = createMCPHost({
		plainTextHook: {
			available: false,
			queue: () => {
				queued += 1;
			},
		},
	});
	const result = await askUser(params, { host });
	assert.equal(result.status, "delivered");
	const text = result.plainText ?? "";
	assert.match(text, /问题 1\/1：Which target\?/); // title
	assert.match(text, /Pick one/); // prompt
	assert.match(text, /输入提示：单选/); // input hint
	assert.match(text, /\[1\] staging — internal only/); // option + description
	assert.match(text, /\[2\] prod — customer facing/);
	assert.doesNotMatch(text, /SECRET PREVIEW/); // no preview
	const lines = text.trimEnd().split("\n");
	assert.match(lines[lines.length - 1]!, /自由输入/); // free input is last

	// Delivered inline means nothing was queued, so it can never be appended twice.
	assert.equal(queued, 0, "an unavailable hook must never receive the text");
});

test("formatMCPDeliveredResult wraps the questionnaire without claiming an answer", async () => {
	const result = await askUser(BASIC, { host: createMCPHost() });
	const text = formatMCPDeliveredResult(result);
	assert.match(text, /尚未回答/);
	assert.match(text, /问题 1\/1：Deploy where\?/);
	assert.match(text, /输入提示：单选/);
	assert.match(text, /\[1\] staging/);
	assert.ok(text.endsWith("自由输入：直接回复你的文本作为答案（可与编号组合，写作 “编号 | 说明”）"));
	// The questionnaire text appears exactly once.
	assert.equal(text.split("问题 1/1").length, 2);
});

test("elicitation answers are parsed like the native route", async () => {
	const answers: string[] = ["2 | because"];
	const elicit: MCPElicitFn = async () => ({ action: "accept", content: { answer: answers.shift() ?? "" } });
	const result = await askUser(BASIC, { host: createMCPHost({ elicit }) });
	assert.equal(result.status, "answered");
	assert.equal(result.route, "native");
	assert.deepEqual(result.answers[0]!.selections, ["prod"]);
	assert.equal(result.answers[0]!.freeText, "because");
});

test("invalid elicitation input is re-asked", async () => {
	let calls = 0;
	const elicit: MCPElicitFn = async () => {
		calls += 1;
		return calls === 1 ? { action: "accept", content: { answer: "9" } } : { action: "accept", content: { answer: "1" } };
	};
	const result = await askUser(BASIC, { host: createMCPHost({ elicit }) });
	assert.equal(result.status, "answered");
	assert.equal(calls, 2);
});

test("declining elicitation cancels", async () => {
	const elicit: MCPElicitFn = async () => ({ action: "decline" });
	const result = await askUser(BASIC, { host: createMCPHost({ elicit }) });
	assert.equal(result.status, "cancelled");
});

test("elicitation receives the remaining time and an abort signal", async () => {
	const seen: Array<{ timeoutMs?: number; hasSignal: boolean }> = [];
	const elicit: MCPElicitFn = async (request) => {
		seen.push({ timeoutMs: request.timeoutMs, hasSignal: !!request.signal });
		return { action: "accept", content: { answer: "1" } };
	};
	const result = await askUser(BASIC, {
		host: createMCPHost({ elicit }),
		now: () => 0,
	});
	assert.equal(result.status, "answered");
	assert.equal(seen[0]!.hasSignal, true);
	assert.ok((seen[0]!.timeoutMs ?? 0) > 0);
});

test("an elicitation that never resolves still times out (core owns the guarantee)", async () => {
	const elicit: MCPElicitFn = () => new Promise<never>(() => {});
	const started = Date.now();
	const result = await askUser(BASIC, {
		host: createMCPHost({ elicit }),
	});
	assert.equal(result.route, "native");
	assert.equal(result.status, "timeout");
	assert.equal(result.deferred, false);
	assert.ok(Date.now() - started < 5000, "must not hang past the deadline");
});

test("a bridge with a real output hook gets deferred:true", async () => {
	const registry = new AppendixRegistry();
	const host = createMCPHost({ plainTextHook: createPlainTextHook(registry) });
	const result = await askUser(BASIC, { host });
	assert.equal(result.route, "plain_text");
	assert.equal(result.status, "deferred");
	assert.equal(result.deferred, true);
	assert.equal(registry.hasPending(), true);
});

test("createMCPFinalOutputHook appends the questionnaire through a real final-message transform", async () => {
	const transforms: Array<(message: unknown) => unknown | undefined> = [];
	const adapter = {
		registerFinalMessageTransform: (transform: (message: unknown) => unknown | undefined) => {
			transforms.push(transform);
			return () => {};
		},
	};
	const host = createMCPHost({ plainTextHook: createMCPFinalOutputHook(adapter) });
	const result = await askUser(BASIC, { host });
	assert.equal(result.status, "deferred");
	assert.equal(result.deferred, true);
	assert.equal(transforms.length, 1, "the hook registers exactly one transform");

	// Simulate one final assistant output before it returns to the caller.
	const finalMessage = { role: "assistant", content: [{ type: "text", text: "Final answer." }] };
	const transformed = transforms[0]!(finalMessage) as { content: Array<{ text?: string }> } | undefined;
	assert.ok(transformed, "the final message must be replaced");
	assert.equal(transformed!.content.length, 2);
	assert.equal(transformed!.content[0]!.text, "Final answer.");
	assert.match(transformed!.content[1]!.text ?? "", /自由输入/);

	// Only one final message receives it; a later one is untouched.
	assert.equal(transforms[0]!(finalMessage), undefined);
});

test("the published contract never advertises custom UI", () => {
	assert.equal(ASKUSERUI_MCP_CONTRACT.toolName, "AskUserUI");
	assert.equal(ASKUSERUI_MCP_CONTRACT.customUI, false);
	assert.ok(ASKUSERUI_MCP_CONTRACT.inputSchema);
});
