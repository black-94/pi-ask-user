import assert from "node:assert/strict";
import { test } from "node:test";
import { Check } from "typebox/value";
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { askUser } from "../src/core.ts";
import { createDeadline } from "../src/deadline.ts";
import { createAskUserHost } from "../src/route.ts";
import { AskUserParams, normalizeAskUserRequest } from "../src/schema.ts";
import { AskUserComponent, type CustomUIResult } from "../src/ui/custom.ts";

const choice = (kind = "single") => ({ title: "Choose", kind, options: [{ label: "A" }, { label: "B" }] });
const K = { enter: "\r", space: " ", down: "\x1b[B", ctrlEnter: "\x1b[13;5u", tab: "\t" };
function mount(raw: unknown, rows = 24) {
	let result: CustomUIResult | undefined;
	const component = new AskUserComponent({
		request: normalizeAskUserRequest(raw).request,
		deadline: createDeadline(10_000),
		theme: { fg: (_color, text) => text, bold: (text) => text },
		tui: { requestRender() {}, terminal: { rows } },
		done: (value) => { result = value; },
	});
	return { component, result: () => result };
}

test("allowFreeText is a strict boolean with a backward-compatible default", () => {
	assert.equal(normalizeAskUserRequest({ questions: [choice()] }).request.allowFreeText, true);
	for (const allowFreeText of [true, false]) {
		const raw = { allowFreeText, questions: [choice(), { title: "Text", kind: "input" }] };
		assert.equal(Check(AskUserParams, raw), true);
		assert.equal(normalizeAskUserRequest(raw).request.questions[0]!.allowFreeText, allowFreeText);
	}
	for (const allowFreeText of ["false", 0, null, []]) {
		const raw = { allowFreeText, questions: [choice()] };
		assert.equal(Check(AskUserParams, raw), false);
		assert.throws(() => normalizeAskUserRequest(raw), /allowFreeText must be a boolean/);
	}
});

test("disabled free text rejects prose defaults but preserves option and input defaults", () => {
	assert.throws(() => normalizeAskUserRequest({ allowFreeText: false, questions: [{ ...choice(), default: "prose" }] }), /default must match an option/);
	assert.doesNotThrow(() => normalizeAskUserRequest({ allowFreeText: false, questions: [
		{ ...choice(), default: "B" }, { title: "Text", kind: "input", default: "prose" },
	] }));
});

test("disabled extra input cannot receive focus or hidden text from typing/down", () => {
	const { component, result } = mount({ allowFreeText: false, questions: [choice()] });
	try {
		component.focused = true;
		assert.doesNotMatch(component.render(80).join("\n"), /›|Optional: add a note/);
		component.handleInput("hidden text");
		component.handleInput(K.down);
		component.handleInput(K.down);
		assert.ok(!component.render(80).join("\n").includes(CURSOR_MARKER));
		component.handleInput(K.enter);
		assert.deepEqual(result()?.answers?.[0]?.selections, ["B"]);
		assert.equal(result()?.answers?.[0]?.freeText, undefined);
	} finally { component.dispose(); }
});

test("disabled multi uses Space to toggle and Enter to confirm without changing selections", () => {
	const { component, result } = mount({ allowFreeText: false, questions: [choice("multi")] });
	try {
		component.handleInput(K.enter);
		assert.equal(result(), undefined);
		component.handleInput(K.space);
		component.handleInput(K.down);
		component.handleInput(K.space);
		component.handleInput(K.enter);
		assert.deepEqual(result()?.answers?.[0]?.selections, ["A", "B"]);
	} finally { component.dispose(); }
});

test("disabled extra text leaves input questions and form text editable", () => {
	const { component, result } = mount({ allowFreeText: false, questions: [
		{ title: "Text", kind: "input" },
		{ title: "Form", kind: "simple-form", fields: [{ name: "note", label: "Note", kind: "input" }] },
	] });
	try {
		component.handleInput("hello");
		component.handleInput(K.enter);
		component.handleInput("world");
		component.handleInput(K.ctrlEnter);
		assert.equal(result()?.answers?.[0]?.freeText, "hello");
		assert.deepEqual(result()?.answers?.[1]?.value, { note: "world" });
	} finally { component.dispose(); }
});

test("choice controls survive one-row terminals when no input is shown", () => {
	for (const rows of [1, 2, 3, 8, 24]) {
		const { component } = mount({ allowFreeText: false, questions: [choice()] }, rows);
		try {
			for (const width of [1, 5, 20, 80]) {
				const lines = component.render(width);
				assert.ok(lines.length <= rows);
				assert.ok(lines.every((line) => visibleWidth(line) <= width));
			}
			assert.match(component.render(80).join("\n"), /1\. A/);
			component.handleInput(K.down);
			assert.match(component.render(80).join("\n"), /2\. B/);
		} finally { component.dispose(); }
	}
});

test("core rejects free text from a renderer when it is disabled", async () => {
	const host = createAskUserHost({ name: "test", customUI: { render: async () => ({
		kind: "submitted", answers: [{ index: 0, id: "q1", title: "Choose", kind: "single", selections: ["A"], freeText: "hidden", usedDefault: false }],
	}) } });
	const result = await askUser({ allowFreeText: false, questions: [choice()] }, { host });
	assert.equal(result.error?.code, "internal");
});

test("bool Enter confirms false defaults; Space toggles and clears usedDefault", () => {
	for (const toggle of [false, true]) {
		const { component, result } = mount({ questions: [{ title: "Bool", kind: "bool", default: false }] });
		try {
			assert.match(component.render(80).join("\n"), /\[✗\] False \(default\)/);
			if (toggle) component.handleInput(K.space);
			component.handleInput(K.enter);
			assert.equal(result()?.answers?.[0]?.value, toggle);
			assert.equal(result()?.answers?.[0]?.usedDefault, !toggle);
		} finally { component.dispose(); }
	}
});

test("form bool is a single control and confirms/toggles false defaults", () => {
	for (const toggle of [false, true]) {
		const { component, result } = mount({ questions: [{ title: "Form", kind: "simple-form", fields: [
			{ name: "enabled", label: "Enabled", kind: "bool", default: false, required: true },
		] }] });
		try {
			const text = component.render(80).join("\n");
			assert.equal(text.split("\n").filter((line) => line.includes("[✗] False")).length, 1);
			assert.doesNotMatch(text, /True/);
			if (toggle) component.handleInput(K.space);
			component.handleInput(K.enter);
			component.handleInput(K.enter);
			assert.deepEqual(result()?.answers?.[0]?.value, { enabled: toggle });
			assert.equal(result()?.answers?.[0]?.usedDefault, !toggle);
		} finally { component.dispose(); }
	}
});
