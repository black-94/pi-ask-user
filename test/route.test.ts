import assert from "node:assert/strict";
import { test } from "node:test";
import { hostCapabilities, pickRoute } from "../src/route.ts";
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

test("route priority: custom > native > plain_text", () => {
	assert.equal(pickRoute({ customUI: true, nativeDialogs: true }), "custom");
	assert.equal(pickRoute({ customUI: false, nativeDialogs: true }), "native");
	assert.equal(pickRoute({ customUI: true, nativeDialogs: false }), "custom");
	assert.equal(pickRoute({ customUI: false, nativeDialogs: false }), "plain_text");
});
