import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAskUser } from "../src/ask.ts";
import { createAskUserHost } from "../src/route.ts";

function noUICtx(): ExtensionContext {
	return { mode: "json", hasUI: false, ui: {} } as unknown as ExtensionContext;
}

function rpcCtx(answer: string | undefined): ExtensionContext {
	return { mode: "rpc", hasUI: true, ui: { input: async () => answer } } as unknown as ExtensionContext;
}

const REQUEST = {
	questions: [{ title: "Deploy where?", kind: "single", options: [{ label: "staging" }, { label: "prod" }] }],
};

test("preflight: an available host reports isAvailable true and no reason", () => {
	const ask = createAskUser(rpcCtx("2"), { configFile: false });
	assert.equal(ask.isAvailable, true);
	assert.equal(ask.notAvailableReason, undefined);
});

test("preflight: an unavailable host reports false plus a reason, before any UI", () => {
	const ask = createAskUser(noUICtx(), { configFile: false });
	assert.equal(ask.isAvailable, false);
	assert.equal(typeof ask.notAvailableReason, "string");
	assert.ok((ask.notAvailableReason ?? "").length > 0);
});

test("an explicitly configured mode that cannot run is refused in preflight", () => {
	const ask = createAskUser(rpcCtx("2"), { mode: "custom", configFile: false });
	assert.equal(ask.isAvailable, false);
	assert.match(ask.notAvailableReason ?? "", /custom/);
});

test("an invalid configured mode is refused in preflight", () => {
	const ask = createAskUser(rpcCtx("2"), { mode: "bogus" as never, configFile: false });
	assert.equal(ask.isAvailable, false);
	assert.match(ask.notAvailableReason ?? "", /custom, native/);
});

test("a direct call returns the result to the caller, never a model payload", async () => {
	const ask = createAskUser(rpcCtx("2"), { configFile: false });
	const result = await ask(REQUEST);
	assert.equal(result.status, "answered");
	assert.equal(result.route, "native");
	assert.equal(result.answers[0]!.selections[0], "prod");
	assert.equal("content" in result, false, "a direct call must not produce a model-facing payload");
});

test("a direct call to an unavailable host fails actionably without throwing", async () => {
	const ask = createAskUser(noUICtx(), { configFile: false });
	assert.equal(ask.isAvailable, false);
	const result = await ask(REQUEST);
	assert.equal(result.status, "error");
	assert.equal(result.error?.code, "unsupported_mode");
	assert.deepEqual(result.answers, []);
});

test("a direct call with an invalid request fails actionably", async () => {
	const ask = createAskUser(rpcCtx("2"), { configFile: false });
	const result = await ask({ questions: [] });
	assert.equal(result.status, "error");
	assert.equal(result.error?.code, "invalid_request");
});

test("createAskUser accepts a pre-built host for reuse", async () => {
	const host = createAskUserHost({
		name: "test",
		nativeDialogs: {
			run: async () => ({
				kind: "submitted",
				answers: [
					{
						index: 0,
						id: "q1",
						title: "Deploy where?",
						kind: "single",
						selections: ["staging"],
						usedDefault: false,
					},
				],
			}),
		},
	});
	const ask = createAskUser(host);
	assert.equal(ask.isAvailable, true);
	assert.equal(ask.host, host);
	const result = await ask(REQUEST);
	assert.equal(result.status, "answered");
	assert.equal(result.answers[0]!.selections[0], "staging");
});

test("a caller may inject an event sink; without one nothing is emitted", async () => {
	const seen: string[] = [];
	const ask = createAskUser(rpcCtx("2"), {
		configFile: false,
		events: {
			waitStarted: () => seen.push("start"),
			waitEnded: (result) => seen.push(`end:${result.status}`),
		},
	});
	const result = await ask(REQUEST);
	assert.equal(result.status, "answered");
	assert.deepEqual(seen, ["start", "end:answered"]);

	// No sink: the deliberate absence, not a fabricated bus.
	const silent = createAskUser(rpcCtx("2"), { configFile: false });
	assert.equal((await silent(REQUEST)).status, "answered");
});

test("a pre-built host can still receive a call-scoped event sink", async () => {
	const host = createAskUserHost({
		name: "test",
		nativeDialogs: {
			run: async () => ({
				kind: "submitted",
				answers: [{ index: 0, id: "q1", title: "Deploy where?", kind: "single", selections: ["staging"], usedDefault: false }],
			}),
		},
	});
	let ended = 0;
	const ask = createAskUser(host, { events: { waitStarted: () => {}, waitEnded: () => { ended += 1; } } });
	assert.equal((await ask(REQUEST)).status, "answered");
	assert.equal(ended, 1);
});
