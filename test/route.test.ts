import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_UI_MODE, UI_MODES, isUIMode, resolveUIMode } from "../src/mode.ts";
import { hostCapabilities } from "../src/route.ts";
import type { AskUserHost } from "../src/types.ts";

test("capabilities are derived from implementations, not booleans", () => {
	const plain: AskUserHost = { name: "plain" };
	assert.deepEqual(hostCapabilities(plain), { customUI: false, nativeDialogs: false });

	const nativeOnly: AskUserHost = {
		name: "native",
		nativeDialogs: { run: async () => ({ kind: "cancelled" }) },
	};
	assert.deepEqual(hostCapabilities(nativeOnly), { customUI: false, nativeDialogs: true });

	const both: AskUserHost = {
		name: "both",
		customUI: { render: async () => ({ kind: "cancelled" }) },
		nativeDialogs: { run: async () => ({ kind: "cancelled" }) },
	};
	assert.deepEqual(hostCapabilities(both), { customUI: true, nativeDialogs: true });
});

test("a declared capability without a callable implementation is not a capability", () => {
	// Simulates a host trying to declare customUI without a renderer.
	const fake = {
		name: "liar",
		customUI: {} as unknown as NonNullable<AskUserHost["customUI"]>,
	} satisfies AskUserHost;
	assert.equal(hostCapabilities(fake).customUI, false);
});

test("capabilities verify a forced mode; they never pick one", () => {
	// No route picker exists any more: routing is configuration. The exports are
	// the capabilities probe plus the mode resolver.
	assert.deepEqual([...UI_MODES], ["custom", "native", "text"]);
	assert.equal(DEFAULT_UI_MODE, "native");
});

test("mode resolution precedence: option > env > default", () => {
	// Nothing configured: the default.
	assert.deepEqual(resolveUIMode(undefined, undefined), { ok: true, mode: "native" });
	assert.deepEqual(resolveUIMode(undefined, ""), { ok: true, mode: "native" });
	assert.deepEqual(resolveUIMode(undefined, "   "), { ok: true, mode: "native" });

	// Env only.
	assert.deepEqual(resolveUIMode(undefined, "text"), { ok: true, mode: "text" });
	assert.deepEqual(resolveUIMode(undefined, " TEXT "), { ok: true, mode: "text" });

	// The programmatic option wins over the env.
	assert.deepEqual(resolveUIMode("custom", "native"), { ok: true, mode: "custom" });
	assert.deepEqual(resolveUIMode("text", "custom"), { ok: true, mode: "text" });
});

test("an invalid env value is an actionable error, not a default", () => {
	const bad = resolveUIMode(undefined, "CUSTOM_UI");
	assert.equal(bad.ok, false);
	if (!bad.ok) {
		assert.match(bad.message, /PI_ASK_USER_UI_MODE/);
		assert.match(bad.message, /CUSTOM_UI/);
		for (const mode of UI_MODES) assert.match(bad.message, new RegExp(mode));
	}
});

test("an invalid programmatic mode is an actionable error, not a default", () => {
	const bad = resolveUIMode("plain_text" as never, undefined);
	assert.equal(bad.ok, false);
	if (!bad.ok) {
		assert.match(bad.message, /plain_text/);
		for (const mode of UI_MODES) assert.match(bad.message, new RegExp(mode));
	}
});

test("isUIMode accepts exactly the three routes and rejects the old name", () => {
	assert.equal(isUIMode("custom"), true);
	assert.equal(isUIMode("native"), true);
	assert.equal(isUIMode("text"), true);
	assert.equal(isUIMode("plain_text"), false);
	assert.equal(isUIMode("TEXT"), false);
	assert.equal(isUIMode(undefined), false);
});
