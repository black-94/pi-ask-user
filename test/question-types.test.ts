import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth, CURSOR_MARKER } from "@earendil-works/pi-tui";
import { Check } from "typebox/value";
import { askUser } from "../src/core.ts";
import { createDeadline } from "../src/deadline.ts";
import { createAskUserHost } from "../src/route.ts";
import { AskUserParams, AskUserValidationError, MAX_FORM_FIELDS, normalizeAskUserRequest } from "../src/schema.ts";
import { AskUserComponent, type AskUserTheme, type CustomUIResult } from "../src/ui/custom.ts";
import { createNativeRunner, type NativeDialogUI } from "../src/ui/native.ts";
import type { AskUserAnswer, NormalizedRequest } from "../src/types.ts";

const theme: AskUserTheme = {
	fg: (_color, text) => text,
	bold: (text) => text,
	italic: (text) => text,
	underline: (text) => text,
	strikethrough: (text) => text,
	inverse: (text) => text,
};

const K = {
	tab: "\t",
	shiftTab: "\x1b[Z",
	enter: "\r",
	space: " ",
	down: "\x1b[B",
	right: "\x1b[C",
	ctrlEnter: "\x1b[13;5u",
};

function request(input: unknown): NormalizedRequest {
	return normalizeAskUserRequest(input).request;
}

function mount(req: NormalizedRequest, rows = 24) {
	let result: CustomUIResult | undefined;
	const component = new AskUserComponent({
		request: req,
		deadline: createDeadline(10_000),
		theme,
		tui: { requestRender: () => {}, terminal: { rows, columns: 80 } },
		done: (value) => { result = value; },
	});
	return { component, result: () => result };
}

const MIXED_FORM = {
	title: "Release settings",
	kind: "simple-form",
	fields: [
		{ name: "confirm", label: "Confirm", kind: "bool", required: true },
		{ name: "target", label: "Target", kind: "single", required: true, options: [{ label: "staging" }, { label: "prod" }] },
		{ name: "checks", label: "Checks", kind: "multi", options: [{ label: "unit" }, { label: "integration" }] },
		{ name: "note", label: "Note", kind: "input" },
	],
} as const;

test("normalization accepts typed bool and flat mixed-form defaults, including false", () => {
	const { request: normalized } = normalizeAskUserRequest({
		questions: [
			{ title: "Proceed?", kind: "bool", default: false },
			{
				title: "Settings",
				kind: "simple-form",
				fields: [
					{ name: "enabled", label: "Enabled", kind: "bool", required: false, default: false },
					{ name: "target", label: "Target", kind: "single", options: [{ label: "a" }, { label: "b" }], default: "b" },
					{ name: "scope", label: "Scope", kind: "multi", options: [{ label: "x" }, { label: "y" }], default: ["x", "y"] },
					{ name: "note", label: "Note", kind: "input", default: "none" },
				],
			},
		],
	});
	assert.equal(normalized.questions[0]!.default, false);
	assert.equal(normalized.questions[0]!.hasDefault, true);
	assert.equal(normalized.questions[1]!.fields?.[0]!.required, false);
	assert.equal(normalized.questions[1]!.fields?.[0]!.default, false);
	assert.deepEqual(normalized.questions[1]!.fields?.[2]!.default, ["x", "y"]);
});

test("normalization rejects malformed, nested, duplicate, unsafe, and path-like form fields", () => {
	const badFields: unknown[] = [
		[{ name: "x", label: "X", kind: "simple-form", fields: [] }],
		[{ name: "x", label: "X", kind: "bool", options: [] }],
		[{ name: "x.y", label: "X", kind: "input" }],
		[{ name: "__proto__", label: "X", kind: "input" }],
		[{ name: "constructor", label: "X", kind: "input" }],
		[{ name: "prototype", label: "X", kind: "input" }],
		[{ name: "x", label: "X", kind: "input", schema: {} }],
	];
	for (const fields of badFields) {
		assert.throws(() => normalizeAskUserRequest({ questions: [{ title: "F", kind: "simple-form", fields }] }), AskUserValidationError);
	}
	assert.throws(
		() => normalizeAskUserRequest({ questions: [{ title: "F", kind: "simple-form", fields: [
			{ name: "same", label: "A", kind: "input" }, { name: "same", label: "B", kind: "bool" },
		] }] }),
		/duplicate field name/i,
	);
	assert.throws(
		() => normalizeAskUserRequest({ questions: [{ title: "F", kind: "simple-form", fields: Array.from({ length: MAX_FORM_FIELDS + 1 }, (_, i) => ({ name: `f${i}`, label: `F${i}`, kind: "input" })) }] }),
		/more than 10 fields/i,
	);
});

test("normalization strictly checks defaults and incompatible top-level members", () => {
	const invalid: unknown[] = [
		{ title: "B", kind: "bool", default: "false" },
		{ title: "B", kind: "bool", options: [] },
		{ title: "F", kind: "simple-form", fields: [{ name: "x", label: "X", kind: "input" }], default: "x" },
		{ title: "I", kind: "input", fields: [] },
		{ title: "F", kind: "simple-form", fields: [{ name: "b", label: "B", kind: "bool", default: "false" }] },
		{ title: "F", kind: "simple-form", fields: [{ name: "s", label: "S", kind: "single", options: [{ label: "a" }], default: "b" }] },
		{ title: "F", kind: "simple-form", fields: [{ name: "m", label: "M", kind: "multi", options: [{ label: "a" }], default: ["b"] }] },
		{ title: "F", kind: "simple-form", fields: [{ name: "m", label: "M", kind: "multi", options: [{ label: "a" }], default: "a" }] },
		{ title: "F", kind: "simple-form", fields: [{ name: "i", label: "I", kind: "input", required: true, default: "  " }] },
		{ title: "F", kind: "simple-form", fields: [{ name: "m", label: "M", kind: "multi", required: true, options: [{ label: "a" }], default: [] }] },
	];
	for (const question of invalid) {
		assert.throws(() => normalizeAskUserRequest({ questions: [question] }), AskUserValidationError, JSON.stringify(question));
	}
});

test("tool schema exposes flat enums and honest typed defaults with the same limits", () => {
	const schema = AskUserParams as unknown as { additionalProperties?: boolean; properties: Record<string, any> };
	const question = schema.properties.questions.items;
	const field = question.properties.fields.items;
	assert.equal(schema.additionalProperties, false);
	assert.deepEqual(question.properties.kind.enum, ["single", "multi", "input", "bool", "simple-form"]);
	assert.equal(question.properties.kind.anyOf, undefined);
	assert.deepEqual(field.properties.kind.enum, ["single", "multi", "input", "bool"]);
	assert.equal(field.properties.kind.anyOf, undefined);
	assert.equal(question.properties.fields.maxItems, MAX_FORM_FIELDS);
	assert.deepEqual(question.properties.default.anyOf.map((entry: any) => entry.type), ["string", "boolean"]);
	assert.deepEqual(field.properties.default.anyOf.map((entry: any) => entry.type), ["boolean", "string", "array"]);
	assert.equal(question.additionalProperties, false);
	assert.equal(field.additionalProperties, false);
	assert.equal(Check(AskUserParams, { questions: [MIXED_FORM, { title: "B", kind: "bool", default: false }] }), true);
	assert.equal(Check(AskUserParams, { questions: [{ title: "B", kind: "bool", default: { nested: true } }] }), false);
	assert.equal(Check(AskUserParams, { questions: [{ title: "F", kind: "simple-form", fields: [
		{ name: "nested", label: "Nested", kind: "simple-form", fields: [] },
	] }] }), false);
});

test("core accepts false and rejects malformed typed renderer outcomes", async () => {
	const boolRequest = { questions: [{ title: "Proceed?", kind: "bool" }] };
	const valid: AskUserAnswer = { index: 0, id: "q1", title: "Proceed?", kind: "bool", selections: [], usedDefault: false, value: false };
	const host = createAskUserHost({ name: "bool", customUI: { render: async () => ({ kind: "submitted", answers: [valid] }) } });
	const accepted = await askUser(boolRequest, { host });
	assert.equal(accepted.status, "answered");
	assert.equal(accepted.answers[0]!.value, false);

	for (const answer of [
		{ ...valid, value: undefined },
		{ ...valid, value: "false" as never },
		{ ...valid, selections: ["false"] },
		{ ...valid, id: "wrong" },
		{ ...valid, extra: true },
	]) {
		const badHost = createAskUserHost({ name: "bad", customUI: { render: async () => ({ kind: "submitted", answers: [answer] }) } });
		assert.equal((await askUser(boolRequest, { host: badHost })).status, "error");
	}
	const malformedHost = createAskUserHost({ name: "bad", customUI: { render: async () => ({ kind: "submitted", answers: {} as never }) } });
	assert.equal((await askUser(boolRequest, { host: malformedHost })).error?.code, "internal");
});

test("core validates required fields, option labels, unknown keys, and false in form outcomes", async () => {
	const raw = { questions: [{ title: "F", kind: "simple-form", fields: [
		{ name: "ok", label: "OK", kind: "bool", required: true },
		{ name: "target", label: "Target", kind: "single", required: true, options: [{ label: "a" }, { label: "b" }] },
	] }] };
	const base: AskUserAnswer = { index: 0, id: "q1", title: "F", kind: "simple-form", selections: [], usedDefault: false, value: { ok: false, target: "b" } };
	const run = async (answer: AskUserAnswer) => askUser(raw, { host: createAskUserHost({ name: "form", customUI: { render: async () => ({ kind: "submitted", answers: [answer] }) } }) });
	assert.equal((await run(base)).status, "answered");
	assert.equal((await run({ ...base, value: { target: "b" } })).error?.code, "empty_answer");
	assert.equal((await run({ ...base, value: { ok: false, target: "c" } })).error?.code, "internal");
	assert.equal((await run({ ...base, value: { ok: false, target: "b", extra: "x" } })).error?.code, "internal");
	const polluted = Object.assign(Object.create({ polluted: true }), { ok: false, target: "b" });
	assert.equal((await run({ ...base, value: polluted })).error?.code, "internal");
});

test("native bool preserves explicit and default false", async () => {
	const explicit = await createNativeRunner({ input: async () => "false" }).run({ request: request({ questions: [{ title: "B", kind: "bool" }] }), deadline: createDeadline(1000) });
	assert.equal(explicit.kind, "submitted");
	assert.equal(explicit.answers?.[0]?.value, false);
	assert.equal(explicit.answers?.[0]?.usedDefault, false);
	const fallback = await createNativeRunner({ input: async () => "" }).run({ request: request({ questions: [{ title: "B", kind: "bool", default: false }] }), deadline: createDeadline(1000) });
	assert.equal(fallback.answers?.[0]?.value, false);
	assert.equal(fallback.answers?.[0]?.usedDefault, true);
});

test("native form asks sequential typed fields and returns a flat object", async () => {
	const queue = ["false", "2", "1,2", "ship it"];
	const prompts: string[] = [];
	const ui: NativeDialogUI = { input: async (title) => { prompts.push(title); return queue.shift(); } };
	const outcome = await createNativeRunner(ui).run({ request: request({ questions: [MIXED_FORM] }), deadline: createDeadline(5000) });
	assert.equal(outcome.kind, "submitted");
	assert.equal(prompts.length, 4);
	assert.match(prompts[0]!, /Field 1\/4/);
	assert.deepEqual(outcome.answers?.[0]?.value, { confirm: false, target: "prod", checks: ["unit", "integration"], note: "ship it" });
});

test("native form re-prompts strict values and omits optional unset fields", async () => {
	const queue = ["no", "false", "free text", "1", "", ""];
	const prompts: string[] = [];
	const outcome = await createNativeRunner({ input: async (title) => { prompts.push(title); return queue.shift(); } }).run({
		request: request({ questions: [MIXED_FORM] }), deadline: createDeadline(5000),
	});
	assert.equal(outcome.kind, "submitted");
	assert.deepEqual(outcome.answers?.[0]?.value, { confirm: false, target: "staging" });
	assert.match(prompts[1]!, /Invalid input/i);
	assert.match(prompts[3]!, /Invalid input/i);
});

test("native form applies typed field defaults while still omitting other optional fields", async () => {
	const queue = ["", "", ""];
	const outcome = await createNativeRunner({ input: async () => queue.shift() }).run({
		request: request({ questions: [{ title: "Defaults", kind: "simple-form", fields: [
			{ name: "enabled", label: "Enabled", kind: "bool", default: false },
			{ name: "scopes", label: "Scopes", kind: "multi", options: [{ label: "a" }, { label: "b" }], default: ["b"] },
			{ name: "note", label: "Note", kind: "input" },
		] }] }),
		deadline: createDeadline(1000),
	});
	assert.deepEqual(outcome.answers?.[0]?.value, { enabled: false, scopes: ["b"] });
	assert.equal(outcome.answers?.[0]?.usedDefault, true);
});

test("native form uses remaining time and supports cancel, abort, and timeout mid-form", async () => {
	let now = 0;
	const seen: number[] = [];
	const timed = await createNativeRunner({ input: async (_title, _placeholder, opts) => {
		seen.push(opts?.timeout ?? -1);
		now += 100;
		return seen.length === 1 ? "false" : undefined;
	} }).run({ request: request({ questions: [MIXED_FORM] }), deadline: createDeadline(150, () => now) });
	assert.equal(timed.kind, "timeout");
	assert.deepEqual(seen, [150, 50]);

	let cancelCalls = 0;
	const cancelled = await createNativeRunner({ input: async () => (++cancelCalls === 1 ? "false" : undefined) }).run({ request: request({ questions: [MIXED_FORM] }), deadline: createDeadline(1000) });
	assert.equal(cancelled.kind, "cancelled");
	assert.equal(cancelCalls, 2);
	const controller = new AbortController();
	let abortCalls = 0;
	const aborted = await createNativeRunner({ input: async () => {
		abortCalls += 1;
		if (abortCalls === 1) return "false";
		controller.abort();
		return undefined;
	} }).run({ request: request({ questions: [MIXED_FORM] }), deadline: createDeadline(1000), signal: controller.signal });
	assert.equal(aborted.kind, "abort");
	assert.equal(abortCalls, 2);
});

test("custom bool uses one toggle control and submits false", () => {
	const { component, result } = mount(request({ questions: [{ title: "Proceed?", kind: "bool" }] }));
	try {
		assert.match(component.render(60).join("\n"), /\[ \] True \(unset\)/);
		component.handleInput(K.space);
		const checked = component.render(60).join("\n");
		assert.match(checked, /\[✓\] True/);
		assert.doesNotMatch(checked, /False/);
		component.handleInput(K.space);
		const crossed = component.render(60).join("\n");
		assert.match(crossed, /\[✗\] False/);
		assert.doesNotMatch(crossed, /True/);
		component.handleInput(K.ctrlEnter);
		assert.equal(result()?.kind, "submitted");
		assert.equal(result()?.answers?.[0]?.value, false);
	} finally { component.dispose(); }
});

test("custom bool applies an explicit false default without a truthiness bug", () => {
	const { component, result } = mount(request({ questions: [{ title: "Proceed?", kind: "bool", default: false }] }));
	component.handleInput("s");
	assert.equal(result()?.answers?.[0]?.value, false);
	assert.equal(result()?.answers?.[0]?.usedDefault, true);
});

test("custom mixed form navigates every field, validates, and submits typed values", () => {
	const { component, result } = mount(request({ questions: [MIXED_FORM] }));
	component.handleInput(K.space); // bool -> true
	component.handleInput(K.space); // bool -> false
	component.handleInput(K.down); // next field
	component.handleInput(K.down); // single focus -> prod
	component.handleInput(K.space); // select prod
	component.handleInput(K.down); // next field
	component.handleInput(K.space); // multi unit
	component.handleInput(K.down);
	component.handleInput(K.space); // multi integration
	component.handleInput(K.down); // next field
	component.handleInput("ship it");
	component.handleInput(K.enter); // button
	component.handleInput(K.enter); // submit
	assert.equal(result()?.kind, "submitted");
	assert.deepEqual(result()?.answers?.[0]?.value, { confirm: false, target: "prod", checks: ["unit", "integration"], note: "ship it" });
});

test("custom form blocks missing required fields and applies typed defaults", () => {
	const missing = mount(request({ questions: [{ title: "F", kind: "simple-form", fields: [{ name: "ok", label: "OK", kind: "bool", required: true }] }] }));
	missing.component.handleInput(K.down); // button
	missing.component.handleInput(K.enter);
	assert.equal(missing.result(), undefined);
	assert.match(missing.component.render(70).join("\n"), /required field.*ok/i);
	missing.component.dispose();

	const defaults = mount(request({ questions: [{ title: "F", kind: "simple-form", fields: [
		{ name: "ok", label: "OK", kind: "bool", required: true, default: false },
		{ name: "target", label: "Target", kind: "single", options: [{ label: "a" }, { label: "b" }], default: "b" },
	] }] }));
	defaults.component.handleInput(K.ctrlEnter);
	assert.equal(defaults.result()?.answers?.[0]?.usedDefault, true);
	assert.deepEqual(defaults.result()?.answers?.[0]?.value, { ok: false, target: "b" });
});

test("custom form Tab switches questions while arrows move field focus", () => {
	const { component } = mount(request({ questions: [MIXED_FORM, { title: "After", kind: "input" }] }));
	try {
		component.handleInput(K.right);
		assert.match(component.render(80).join("\n"), /▸ Target/);
		component.handleInput(K.tab);
		assert.match(component.render(80).join("\n"), /2\/2\. After/);
		component.handleInput(K.shiftTab);
		assert.match(component.render(80).join("\n"), /1\/2\. Release settings/);
		assert.match(component.render(80).join("\n"), /▸ Target/);
		component.handleInput("\x1b[1;5C");
		assert.match(component.render(80).join("\n"), /2\/2\. After/);
		component.handleInput("\x1b[1;5D");
		assert.match(component.render(80).join("\n"), /1\/2\. Release settings/);
	} finally { component.dispose(); }
});

test("custom form advances through questionnaire review and preserves typed values", () => {
	const { component, result } = mount(request({ questions: [
		{ title: "Form", kind: "simple-form", fields: [{ name: "ok", label: "OK", kind: "bool", required: true }] },
		{ title: "Note", kind: "input" },
	] }));
	component.handleInput(K.space); // true
	component.handleInput(K.space); // false
	component.handleInput(K.down); // button
	component.handleInput(K.enter); // continue to question 2
	component.handleInput("ready");
	component.handleInput(K.enter); // review
	const review = component.render(90).join("\n");
	assert.match(review, /Review before submitting/);
	assert.match(review, /ok=✗ False/);
	component.handleInput(K.enter);
	assert.equal(result()?.kind, "submitted");
	assert.deepEqual(result()?.answers?.[0]?.value, { ok: false });
	assert.equal(result()?.answers?.[1]?.freeText, "ready");
});

test("custom form keeps focused fields visible and IME cursor positioned in narrow short viewports", () => {
	const fields = Array.from({ length: 10 }, (_, index) => ({ name: `f${index}`, label: `Field ${index}`, kind: "input" as const }));
	const { component } = mount(request({ questions: [{ title: "Long", kind: "simple-form", fields }] }), 8);
	component.focused = true;
	for (let index = 0; index < fields.length; index += 1) {
		const lines = component.render(22);
		assert.ok(lines.every((line) => visibleWidth(line) <= 22));
		assert.ok(lines.length <= 8);
		assert.match(lines.join("\n"), new RegExp(`Field ${index}`));
		assert.ok(lines.join("\n").includes(CURSOR_MARKER), `field ${index} should retain the IME cursor marker`);
		if (index < fields.length - 1) component.handleInput(K.down);
	}
	component.dispose();
});

test("custom form Space toggles the boolean value", () => {
	const { component, result } = mount(request({ questions: [{ title: "F", kind: "simple-form", fields: [
		{ name: "ok", label: "OK", kind: "bool", required: true },
	] }] }));
	try {
		component.handleInput(K.space);
		assert.match(component.render(80).join("\n"), /\[✓\] True/);
		component.handleInput(K.space);
		assert.match(component.render(80).join("\n"), /\[✗\] False/);
		component.handleInput(K.ctrlEnter);
		assert.deepEqual(result()?.answers?.[0]?.value, { ok: false });
	} finally { component.dispose(); }
});

test("custom form text accepts brackets and preserves defaults on cursor movement", () => {
	const { component, result } = mount(request({ questions: [{ title: "F", kind: "simple-form", fields: [
		{ name: "note", label: "Note", kind: "input", default: "seed" },
	] }] }));
	try {
		component.handleInput("\x1b[D");
		component.handleInput(K.ctrlEnter);
		assert.equal(result()?.answers?.[0]?.usedDefault, true);
	} finally { component.dispose(); }
	const edited = mount(request({ questions: [{ title: "F", kind: "simple-form", fields: [
		{ name: "note", label: "Note", kind: "input", required: true },
	] }] }));
	try {
		edited.component.handleInput("[");
		edited.component.handleInput("value");
		edited.component.handleInput("]");
		edited.component.handleInput(K.ctrlEnter);
		assert.deepEqual(edited.result()?.answers?.[0]?.value, { note: "[value]" });
	} finally { edited.component.dispose(); }
});

test("custom form auto-scrolls the actual focused choice past long descriptions", () => {
	const { component } = mount(request({ questions: [{ title: "F", kind: "simple-form", fields: [
		{ name: "target", label: "Target", kind: "single", options: Array.from({ length: 5 }, (_, index) => ({
			label: `option-${index}`, description: "a long description ".repeat(10),
		})) },
	] }] }), 8);
	try {
		for (let index = 0; index < 5; index += 1) {
			assert.match(component.render(40).join("\n"), new RegExp(`option-${index}`));
			component.handleInput(K.down);
		}
	} finally { component.dispose(); }
});

test("typed controls and form text stay visible even in one-to-five-row terminals", () => {
	for (const rows of [1, 2, 3, 5]) {
		const bool = mount(request({ questions: [{ title: "B", kind: "bool" }] }), rows);
		try {
			assert.match(bool.component.render(40).join("\n"), /True/);
			bool.component.handleInput(K.down);
			assert.match(bool.component.render(40).join("\n"), /True \(unset\)/);
			bool.component.handleInput(K.space);
			bool.component.handleInput(K.space);
			assert.match(bool.component.render(40).join("\n"), /False/);
		} finally { bool.component.dispose(); }
		const form = mount(request({ questions: [{ title: "F", kind: "simple-form", fields: [
			{ name: "note", label: "Note", kind: "input" },
		] }] }), rows);
		try {
			form.component.focused = true;
			assert.ok(form.component.render(40).join("\n").includes(CURSOR_MARKER), `rows=${rows}`);
		} finally { form.component.dispose(); }
	}
});

test("custom Ctrl+Enter focuses the first invalid form field, not the button", () => {
	const { component, result } = mount(request({ questions: [{ title: "F", kind: "simple-form", fields: [
		{ name: "note", label: "Note", kind: "input", required: true },
		{ name: "ok", label: "OK", kind: "bool" },
	] }] }));
	try {
		component.handleInput(K.down);
		component.handleInput(K.down);
		component.handleInput(K.ctrlEnter);
		assert.equal(result(), undefined);
		assert.match(component.render(80).join("\n"), /▸ Note/);
		component.handleInput("ready");
		component.handleInput(K.ctrlEnter);
		assert.deepEqual(result()?.answers?.[0]?.value, { note: "ready" });
	} finally { component.dispose(); }
});

test("native form does not open another dialog after abort or accept a late value", async () => {
	const controller = new AbortController();
	let calls = 0;
	const aborted = await createNativeRunner({ input: async () => {
		calls += 1;
		controller.abort();
		return "false";
	} }).run({ request: request({ questions: [MIXED_FORM] }), deadline: createDeadline(1000), signal: controller.signal });
	assert.equal(aborted.kind, "abort");
	assert.equal(calls, 1);
	let now = 0;
	const late = await createNativeRunner({ input: async () => { now = 200; return "false"; } }).run({
		request: request({ questions: [{ title: "B", kind: "bool" }] }), deadline: createDeadline(100, () => now),
	});
	assert.equal(late.kind, "timeout");
});

test("custom and native form text have the same trimming and omission rules", async () => {
	const req = request({ questions: [{ title: "F", kind: "simple-form", fields: [
		{ name: "note", label: "Note", kind: "input" },
		{ name: "empty", label: "Empty", kind: "input" },
	] }] });
	const custom = mount(req);
	try {
		custom.component.handleInput("  hello  ");
		custom.component.handleInput(K.down);
		custom.component.handleInput("   ");
		custom.component.handleInput(K.ctrlEnter);
		const queue = ["  hello  ", "   "];
		const native = await createNativeRunner({ input: async () => queue.shift() }).run({
			request: req, deadline: createDeadline(1000),
		});
		assert.deepEqual(custom.result()?.answers?.[0]?.value, { note: "hello" });
		assert.deepEqual(custom.result()?.answers?.[0]?.value, native.answers?.[0]?.value);
	} finally { custom.component.dispose(); }
});

test("custom forms retain IME markers at extremely narrow widths", () => {
	const { component } = mount(request({ questions: [{ title: "F", kind: "simple-form", fields: [
		{ name: "note", label: "Note", kind: "input" },
	] }] }), 3);
	try {
		component.focused = true;
		for (const width of [1, 2, 3, 4, 5, 10]) {
			const lines = component.render(width);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			assert.ok(lines.join("\n").includes(CURSOR_MARKER), `width=${width}`);
		}
	} finally { component.dispose(); }
});

test("form paging is relative to the visible window and editing restores the active field", () => {
	const fields = Array.from({ length: 10 }, (_, index) => ({ name: `f${index}`, label: `Field ${index}`, kind: "input" }));
	const { component, result } = mount(request({ questions: [{ title: "F", kind: "simple-form", fields }] }), 8);
	try {
		component.focused = true;
		for (let index = 0; index < 9; index += 1) component.handleInput(K.down);
		assert.match(component.render(40).join("\n"), /Field 9/);
		for (let index = 0; index < 20; index += 1) {
			component.handleInput("\x1b[5~");
			component.render(40);
		}
		assert.match(component.render(40).join("\n"), /Field 0/);
		component.handleInput("last field");
		const restored = component.render(40).join("\n");
		assert.match(restored, /Field 9/);
		assert.ok(restored.includes(CURSOR_MARKER));
		component.handleInput(K.ctrlEnter);
		assert.deepEqual(result()?.answers?.[0]?.value, { f9: "last field" });
	} finally { component.dispose(); }
});
