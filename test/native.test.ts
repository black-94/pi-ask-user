import assert from "node:assert/strict";
import { test } from "node:test";
import { createDeadline } from "../src/deadline.ts";
import { normalizeAskUserRequest } from "../src/schema.ts";
import { createNativeRunner, type NativeDialogUI } from "../src/ui/native.ts";
import type { NormalizedRequest } from "../src/types.ts";

function request(input: unknown): NormalizedRequest {
	return normalizeAskUserRequest(input).request;
}

function scriptedUI(answers: Array<string | undefined>): { ui: NativeDialogUI; prompts: string[] } {
	const prompts: string[] = [];
	const queue = [...answers];
	const ui: NativeDialogUI = {
		async input(title) {
			prompts.push(title);
			return queue.shift();
		},
	};
	return { ui, prompts };
}

test("one input per question, parsed into selections", async () => {
	const req = request({
		questions: [
			{ title: "One", kind: "single", options: [{ label: "a" }, { label: "b" }] },
			{ title: "Many", kind: "multi", options: [{ label: "x" }, { label: "y" }, { label: "z" }] },
			{ title: "Note", kind: "input" },
		],
	});
	const { ui, prompts } = scriptedUI(["2", "1,3", "hello there"]);
	const outcome = await createNativeRunner(ui).run({
		request: req,
		deadline: createDeadline(5000),
	});
	assert.equal(outcome.kind, "submitted");
	assert.equal(prompts.length, 3);
	assert.deepEqual(outcome.answers![0]!.selections, ["b"]);
	assert.deepEqual(outcome.answers![1]!.selections, ["x", "z"]);
	assert.equal(outcome.answers![2]!.freeText, "hello there");
});

test("invalid input re-prompts with the reason", async () => {
	const req = request({ questions: [{ title: "One", kind: "single", options: [{ label: "a" }, { label: "b" }] }] });
	const { ui, prompts } = scriptedUI(["7", "1,2", "1"]);
	const outcome = await createNativeRunner(ui).run({ request: req, deadline: createDeadline(5000) });
	assert.equal(outcome.kind, "submitted");
	assert.equal(prompts.length, 3);
	assert.match(prompts[1]!, /out of range/i);
	assert.match(prompts[2]!, /single-select/i);
	assert.deepEqual(outcome.answers![0]!.selections, ["a"]);
});

test("empty input with a default uses the default", async () => {
	const req = request({ questions: [{ title: "One", kind: "single", options: [{ label: "a" }, { label: "b" }], default: "b" }] });
	const { ui } = scriptedUI([""]);
	const outcome = await createNativeRunner(ui).run({ request: req, deadline: createDeadline(5000) });
	assert.equal(outcome.kind, "submitted");
	assert.deepEqual(outcome.answers![0]!.selections, ["b"]);
	assert.equal(outcome.answers![0]!.usedDefault, true);
});

test("empty input without a default re-prompts then accepts", async () => {
	const req = request({ questions: [{ title: "Note", kind: "input" }] });
	const { ui, prompts } = scriptedUI(["", "real answer"]);
	const outcome = await createNativeRunner(ui).run({ request: req, deadline: createDeadline(5000) });
	assert.equal(outcome.kind, "submitted");
	assert.equal(prompts.length, 2);
	assert.match(prompts[1]!, /cannot be empty/i);
	assert.equal(outcome.answers![0]!.freeText, "real answer");
});

test("dismissal cancels the whole questionnaire", async () => {
	const req = request({
		questions: [
			{ title: "One", kind: "single", options: [{ label: "a" }, { label: "b" }] },
			{ title: "Two", kind: "single", options: [{ label: "c" }, { label: "d" }] },
		],
	});
	const { ui } = scriptedUI(["1", undefined]);
	const outcome = await createNativeRunner(ui).run({ request: req, deadline: createDeadline(5000) });
	assert.equal(outcome.kind, "cancelled");
});

test("expired deadline reports a timeout, not a cancel", async () => {
	const req = request({ questions: [{ title: "One", kind: "single", options: [{ label: "a" }, { label: "b" }] }] });
	let now = 0;
	const deadline = createDeadline(100, () => now);
	const ui: NativeDialogUI = {
		async input() {
			now = 200; // the dialog times out
			return undefined;
		},
	};
	const outcome = await createNativeRunner(ui).run({ request: req, deadline });
	assert.equal(outcome.kind, "timeout");
});

test("only the remaining time is handed to each dialog", async () => {
	const req = request({
		questions: [
			{ title: "One", kind: "single", options: [{ label: "a" }, { label: "b" }] },
			{ title: "Two", kind: "single", options: [{ label: "c" }, { label: "d" }] },
		],
	});
	let now = 0;
	const deadline = createDeadline(1000, () => now);
	const seen: number[] = [];
	const ui: NativeDialogUI = {
		async input(_title, _placeholder, opts) {
			seen.push(opts?.timeout ?? -1);
			now += 300; // each answer consumes time
			return "1";
		},
	};
	const outcome = await createNativeRunner(ui).run({ request: req, deadline });
	assert.equal(outcome.kind, "submitted");
	assert.equal(seen.length, 2);
	assert.equal(seen[0], 1000);
	assert.equal(seen[1], 700);
});

test("caller abort is reported as abort", async () => {
	const req = request({ questions: [{ title: "One", kind: "single", options: [{ label: "a" }, { label: "b" }] }] });
	const controller = new AbortController();
	controller.abort();
	const ui: NativeDialogUI = { input: async () => undefined };
	const outcome = await createNativeRunner(ui).run({
		request: req,
		deadline: createDeadline(5000),
		signal: controller.signal,
	});
	assert.equal(outcome.kind, "abort");
});
