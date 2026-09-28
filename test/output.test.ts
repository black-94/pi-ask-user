import assert from "node:assert/strict";
import { test } from "node:test";
import {
	AppendixRegistry,
	createPlainTextHook,
	createUnavailablePlainTextHook,
	flushAppendix,
} from "../src/output.ts";

test("registry queues, reports, and drains atomically", () => {
	const registry = new AppendixRegistry();
	assert.equal(registry.hasPending(), false);
	registry.queue("first");
	registry.queue("second");
	registry.queue("   "); // ignored
	assert.equal(registry.hasPending(), true);
	assert.equal(registry.takeAll(), "first\n\nsecond");
	assert.equal(registry.takeAll(), undefined);
});

test("flushAppendix appends to a final assistant message only", () => {
	const registry = new AppendixRegistry();
	registry.queue("APPENDIX");

	const withToolCall = {
		role: "assistant",
		content: [{ type: "toolCall", id: "1", name: "AskUserUI", arguments: {} }],
	};
	assert.equal(flushAppendix(withToolCall, registry), undefined);
	assert.equal(registry.hasPending(), true);

	const user = { role: "user", content: "hi" };
	assert.equal(flushAppendix(user, registry), undefined);
	assert.equal(registry.hasPending(), true);

	const final = { role: "assistant", content: [{ type: "text", text: "Done." }] };
	const flushed = flushAppendix(final, registry);
	assert.ok(flushed);
	assert.deepEqual(flushed!.content, [
		{ type: "text", text: "Done." },
		{ type: "text", text: "APPENDIX" },
	]);
	assert.equal(registry.hasPending(), false);
	// Second flush is a no-op: nothing is duplicated.
	assert.equal(flushAppendix(flushed!, registry), undefined);
});

test("the plain-text hook is available and writes to its registry", () => {
	const registry = new AppendixRegistry();
	const hook = createPlainTextHook(registry);
	assert.equal(hook.available, true);
	hook.queue("x");
	assert.equal(registry.hasPending(), true);
});

test("the unavailable hook reports itself honestly", () => {
	const hook = createUnavailablePlainTextHook();
	assert.equal(hook.available, false);
	hook.queue("ignored");
});
