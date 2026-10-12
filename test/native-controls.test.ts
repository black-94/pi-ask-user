import assert from "node:assert/strict";
import { test } from "node:test";
import { createDeadline } from "../src/deadline.ts";
import { normalizeAskUserRequest } from "../src/schema.ts";
import { createNativeRunner, type NativeDialogUI } from "../src/ui/native.ts";

const choice = (kind = "single") => ({ title: "Choose", kind, options: [{ label: "A" }, { label: "B", description: "Beta" }] });
const req = (questions: unknown[], allowFreeText = false) => normalizeAskUserRequest({ questions, allowFreeText }).request;

test("disabled free text uses native select for single and bool, not input", async () => {
	const prompts: string[] = [];
	const outcome = await createNativeRunner({
		input: async () => { assert.fail("no text input expected"); },
		select: async (title, options) => { prompts.push(title); return options[1]; },
	}).run({ request: req([choice(), { title: "Proceed", kind: "bool" }]), deadline: createDeadline(1000) });
	assert.equal(outcome.kind, "submitted");
	assert.deepEqual(outcome.answers?.[0]?.selections, ["B"]);
	assert.equal(outcome.answers?.[1]?.value, false);
	assert.ok(prompts.every((title) => !/free text|empty box|Reply with/i.test(title)));
});

test("native multi remains one text box and rejects notes/prose when disabled", async () => {
	const queue = ["prose", "1 | note", "1,2"];
	const prompts: string[] = [];
	const placeholders: string[] = [];
	const outcome = await createNativeRunner({
		input: async (title, placeholder) => { prompts.push(title); placeholders.push(placeholder!); return queue.shift(); },
		select: async () => { assert.fail("multi must use a text box"); },
	}).run({ request: req([choice("multi")]), deadline: createDeadline(1000) });
	assert.equal(outcome.kind, "submitted");
	assert.equal(prompts.length, 3);
	assert.match(prompts[1]!, /Invalid input/);
	assert.deepEqual(outcome.answers?.[0]?.selections, ["A", "B"]);
	assert.equal(outcome.answers?.[0]?.freeText, undefined);
	assert.ok(placeholders.every((placeholder) => !/note|free text/i.test(placeholder)));
});

test("native form uses select for bool/single but text for multi/input", async () => {
	const calls: string[] = [];
	const text = ["1,2", "  release  "];
	const outcome = await createNativeRunner({
		input: async () => { calls.push("input"); return text.shift(); },
		select: async (_title, options) => { calls.push("select"); return options[1]; },
	}).run({ request: req([{ title: "Form", kind: "simple-form", fields: [
		{ name: "ok", label: "OK", kind: "bool", required: true },
		{ name: "target", label: "Target", kind: "single", options: choice().options },
		{ name: "checks", label: "Checks", kind: "multi", options: choice().options },
		{ name: "note", label: "Note", kind: "input" },
	] }]), deadline: createDeadline(1000) });
	assert.deepEqual(calls, ["select", "select", "input", "input"]);
	assert.deepEqual(outcome.answers?.[0]?.value, { ok: false, target: "B", checks: ["A", "B"], note: "release" });
});

test("native typed controls preserve defaults and omit optional skipped fields", async () => {
	const outcome = await createNativeRunner({
		input: async () => { assert.fail("no text input expected"); },
		select: async (_title, options) => options.find((option) => option.startsWith("Use default:")) ?? options.at(-1),
	}).run({ request: req([
		{ title: "Bool", kind: "bool", default: false },
		{ ...choice(), default: " B " },
		{ title: "Form", kind: "simple-form", fields: [
			{ name: "ok", label: "OK", kind: "bool", default: false, required: true },
			{ name: "target", label: "Target", kind: "single", options: choice().options },
		] },
	]), deadline: createDeadline(1000) });
	assert.equal(outcome.kind, "submitted");
	assert.equal(outcome.answers?.[0]?.value, false);
	assert.deepEqual(outcome.answers?.[1]?.selections, ["B"]);
	assert.deepEqual(outcome.answers?.[2]?.value, { ok: false });
	assert.ok(outcome.answers?.every((answer) => answer.usedDefault));
});

test("native bool dismissal is cancelled, never an explicit false answer", async () => {
	let inputCalls = 0;
	const outcome = await createNativeRunner({ input: async () => { inputCalls++; return "false"; }, select: async () => undefined })
		.run({ request: req([{ title: "Bool", kind: "bool" }]), deadline: createDeadline(1000) });
	assert.equal(outcome.kind, "cancelled");
	assert.equal(outcome.answers, undefined);
	assert.equal(inputCalls, 0);
});

test("typed native controls share deadlines and never accept late/aborted responses", async () => {
	let now = 0;
	const remaining: number[] = [];
	const outcome = await createNativeRunner({ input: async () => "", select: async (_title, options, opts) => {
		remaining.push(opts!.timeout!);
		now += 100;
		return options[0];
	} }).run({ request: req([choice(), { title: "Bool", kind: "bool" }]), deadline: createDeadline(150, () => now) });
	assert.deepEqual(remaining, [150, 50]);
	assert.equal(outcome.kind, "timeout");
	const controller = new AbortController();
	let calls = 0;
	const aborted = await createNativeRunner({ input: async () => "", select: async (_title, options, opts) => {
		calls++;
		assert.equal(opts!.signal, controller.signal);
		controller.abort();
		return options[0];
	} }).run({ request: req([choice(), choice()]), deadline: createDeadline(1000), signal: controller.signal });
	assert.equal(aborted.kind, "abort");
	assert.equal(calls, 1);
});

test("missing/failed select never falls back to input; multi/input need no select", async () => {
	let calls = 0;
	const ui: NativeDialogUI = { input: async () => { calls++; return "1"; } };
	const missing = await createNativeRunner(ui).run({ request: req([choice()]), deadline: createDeadline(1000) });
	assert.equal(missing.kind, "error");
	assert.match(missing.message!, /ui.select/);
	assert.equal(calls, 0);
	const failed = await createNativeRunner({ ...ui, select: async () => { throw new Error("selector failed"); } })
		.run({ request: req([choice()]), deadline: createDeadline(1000) });
	assert.equal(failed.kind, "error");
	assert.match(failed.message!, /selector failed/);
	assert.equal(calls, 0);
	const texts = await createNativeRunner(ui).run({ request: req([choice("multi"), { title: "Text", kind: "input" }]), deadline: createDeadline(1000) });
	assert.equal(texts.kind, "submitted");
	assert.equal(calls, 2);
});

test("unknown native select values are errors rather than guessed answers", async () => {
	const outcome = await createNativeRunner({ input: async () => "", select: async () => "not an option" })
		.run({ request: req([choice()]), deadline: createDeadline(1000) });
	assert.equal(outcome.kind, "error");
});

test("default-enabled native route retains input boxes and free-text notes", async () => {
	const outcome = await createNativeRunner({ input: async () => "2 | note", select: async () => { assert.fail("legacy path"); } })
		.run({ request: req([choice()], true), deadline: createDeadline(1000) });
	assert.equal(outcome.kind, "submitted");
	assert.deepEqual(outcome.answers?.[0]?.selections, ["B"]);
	assert.equal(outcome.answers?.[0]?.freeText, "note");
});
