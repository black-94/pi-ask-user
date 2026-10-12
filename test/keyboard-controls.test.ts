import assert from "node:assert/strict";
import { test } from "node:test";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { createDeadline } from "../src/deadline.ts";
import { normalizeAskUserRequest } from "../src/schema.ts";
import { AskUserComponent, type CustomUIResult } from "../src/ui/custom.ts";

const K = { up: "\x1b[A", down: "\x1b[B", left: "\x1b[D", right: "\x1b[C", enter: "\r", space: " ", tab: "\t", shiftTab: "\x1b[Z", ctrlEnter: "\x1b[13;5u" };
const arrows = [K.up, K.down, K.left, K.right];
const choices = [{ label: "A" }, { label: "B" }];

function mount(raw: unknown) {
	let result: CustomUIResult | undefined;
	const component = new AskUserComponent({
		request: normalizeAskUserRequest(raw).request,
		deadline: createDeadline(10_000),
		theme: { fg: (_color, text) => text, bold: (text) => text },
		tui: { requestRender() {}, terminal: { rows: 24, columns: 120 } },
		done: (value) => { result = value; },
	});
	component.focused = true;
	return { component, result: () => result, text: () => component.render(120).join("\n") };
}

for (const displayMode of ["overlay", "inline"]) {
	for (const initial of [undefined, false, true]) {
		test(`${displayMode}: bool arrows preserve unset/default values and provenance (${initial})`, () => {
			const ui = mount({ displayMode, questions: [{ title: "Bool", kind: "bool", ...(initial === undefined ? {} : { default: initial }) }] });
			try {
				const before = ui.text();
				for (const key of [...arrows, "\x10", "\x0e"]) {
					ui.component.handleInput(key);
					assert.equal(ui.text(), before);
				}
				ui.component.handleInput(K.enter);
				if (initial === undefined) {
					assert.equal(ui.result(), undefined, "Enter must not implicitly set true");
					assert.match(ui.text(), /True \(unset\)/);
					ui.component.handleInput(K.space);
					ui.component.handleInput(K.enter);
					assert.equal(ui.result()?.answers?.[0]?.value, true);
					assert.equal(ui.result()?.answers?.[0]?.usedDefault, false);
				} else {
					assert.equal(ui.result()?.answers?.[0]?.value, initial);
					assert.equal(ui.result()?.answers?.[0]?.usedDefault, true);
				}
			} finally { ui.component.dispose(); }
		});
	}

	for (const kind of ["single", "multi"]) {
		for (const allowFreeText of [false, true]) {
			test(`${displayMode}: ${kind}, free text ${allowFreeText}: arrows focus, Space selects, Enter only confirms`, () => {
				const ui = mount({ displayMode, allowFreeText, questions: [{ title: "Choice", kind, options: choices }] });
				try {
					ui.component.handleInput(K.right);
					assert.match(ui.text(), /▸ [○▢] 2\. B/);
					ui.component.handleInput(K.enter);
					assert.equal(ui.result(), undefined);
					assert.doesNotMatch(ui.text(), /◉|▣/);
					ui.component.handleInput(K.space);
					ui.component.handleInput(K.left);
					assert.match(ui.text(), /▸ [○▢] 1\. A/);
					assert.match(ui.text(), /[◉▣] 2\. B/);
					ui.component.handleInput(K.enter); // A is focused but B must remain the sole selection
					assert.equal(ui.result()?.kind, "submitted");
					assert.deepEqual(ui.result()?.answers?.[0]?.selections, ["B"]);
				} finally { ui.component.dispose(); }
			});
		}
	}

	for (const [back, forward] of [[K.up, K.down], [K.left, K.right]] as const) {
		test(`${displayMode}: form arrows traverse bool/text/choices/button without editing values (${back})`, () => {
			const ui = mount({ displayMode, questions: [{ title: "Form", kind: "simple-form", fields: [
				{ name: "bool", label: "Bool", kind: "bool", default: false },
				{ name: "text", label: "Text", kind: "input", default: "seed" },
				{ name: "single", label: "Single", kind: "single", options: choices, default: "B" },
				{ name: "multi", label: "Multi", kind: "multi", options: choices, default: ["A"] },
			] }] });
			try {
				ui.component.handleInput(back); // start boundary
				assert.match(ui.text(), /▸ Bool/);
				ui.component.handleInput(forward);
				assert.match(ui.text(), /▸ Text/);
				assert.ok(ui.text().includes(CURSOR_MARKER));
				ui.component.handleInput(forward);
				assert.match(ui.text(), /▸ Single/);
				assert.match(ui.text(), /▸ ○ A/);
				assert.ok(!ui.text().includes(CURSOR_MARKER));
				ui.component.handleInput(forward);
				assert.match(ui.text(), /▸ ◉ B/);
				ui.component.handleInput(forward);
				assert.match(ui.text(), /▸ Multi/);
				assert.match(ui.text(), /▸ ▣ A/);
				ui.component.handleInput(forward);
				assert.match(ui.text(), /▸ ▢ B/);
				ui.component.handleInput(forward);
				assert.match(ui.text(), /▸ \[ Enter Submit \]/);
				ui.component.handleInput(forward); // end boundary
				assert.match(ui.text(), /▸ \[ Enter Submit \]/);
				ui.component.handleInput(back);
				assert.match(ui.text(), /▸ Multi/);
				assert.match(ui.text(), /▸ ▢ B/);
				ui.component.handleInput(back);
				ui.component.handleInput(back);
				assert.match(ui.text(), /▸ Single/);
				assert.match(ui.text(), /▸ ◉ B/);
				ui.component.handleInput(back);
				ui.component.handleInput(back);
				assert.match(ui.text(), /▸ Text/);
				ui.component.handleInput(back);
				assert.match(ui.text(), /▸ Bool/);
				ui.component.handleInput(K.ctrlEnter);
				assert.deepEqual(ui.result()?.answers?.[0]?.value, { bool: false, text: "seed", single: "B", multi: ["A"] });
				assert.equal(ui.result()?.answers?.[0]?.usedDefault, true);
			} finally { ui.component.dispose(); }
		});
	}
}

test("form Enter never implicitly sets optional bool/single or overwrites a choice default", () => {
	const ui = mount({ questions: [{ title: "Form", kind: "simple-form", fields: [
		{ name: "bool", label: "Bool", kind: "bool" },
		{ name: "single", label: "Single", kind: "single", options: choices },
		{ name: "default", label: "Default", kind: "single", options: choices, default: "B" },
		{ name: "multi", label: "Multi", kind: "multi", options: choices, default: ["A"] },
	] }] });
	try {
		ui.component.handleInput(K.enter);
		ui.component.handleInput(K.enter);
		ui.component.handleInput(K.left); // focus A in defaulted single field
		ui.component.handleInput(K.enter);
		ui.component.handleInput(K.enter);
		ui.component.handleInput(K.enter);
		assert.deepEqual(ui.result()?.answers?.[0]?.value, { default: "B", multi: ["A"] });
		assert.equal(ui.result()?.answers?.[0]?.usedDefault, true);
	} finally { ui.component.dispose(); }
});

test("required form bool/single remain unset after Enter and block submission", () => {
	for (const kind of ["bool", "single"]) {
		const ui = mount({ questions: [{ title: "Form", kind: "simple-form", fields: [
			{ name: "required", label: "Required", kind, required: true, ...(kind === "single" ? { options: choices } : {}) },
		] }] });
		try {
			ui.component.handleInput(K.enter);
			ui.component.handleInput(K.enter);
			assert.equal(ui.result(), undefined);
			assert.match(ui.text(), /required field/);
			assert.match(ui.text(), /▸ Required/);
			ui.component.handleInput(K.space);
			ui.component.handleInput(K.ctrlEnter);
			assert.deepEqual(ui.result()?.answers?.[0]?.value, { required: kind === "bool" ? true : "A" });
		} finally { ui.component.dispose(); }
	}
});

test("Tab switches every question kind and review, not form fields or review button", () => {
	const ui = mount({ questions: [
		{ title: "Form", kind: "simple-form", fields: [{ name: "text", label: "Text", kind: "input" }] },
		{ title: "Bool", kind: "bool", default: false },
		{ title: "Single", kind: "single", options: choices },
		{ title: "Multi", kind: "multi", options: choices },
		{ title: "Input", kind: "input" },
	] });
	try {
		ui.component.handleInput("saved");
		for (const title of ["Bool", "Single", "Multi", "Input"]) {
			ui.component.handleInput(K.tab);
			assert.match(ui.text(), new RegExp(`\\d/5\\. ${title}`));
		}
		ui.component.handleInput(K.tab);
		assert.match(ui.text(), /Review before submitting/);
		ui.component.handleInput(K.right);
		assert.match(ui.text(), /▸ \[ Enter Submit \]/);
		ui.component.handleInput(K.left);
		assert.match(ui.text(), /  \[ Enter Submit \]/);
		ui.component.handleInput(K.right);
		ui.component.handleInput(K.tab);
		assert.match(ui.text(), /1\/5\. Form/);
		assert.match(ui.text(), /saved/);
		ui.component.handleInput(K.shiftTab);
		assert.match(ui.text(), /Review before submitting/);
		ui.component.handleInput(K.shiftTab);
		assert.match(ui.text(), /5\/5\. Input/);
	} finally { ui.component.dispose(); }
});

test("text arrows move control focus, Space inserts text, Ctrl+B/F still edit the text cursor", () => {
	for (const form of [false, true]) {
		const ui = mount({ questions: [form
			? { title: "Form", kind: "simple-form", fields: [{ name: "note", label: "Note", kind: "input" }, { name: "bool", label: "Bool", kind: "bool" }] }
			: { title: "Choice", kind: "single", options: choices }] });
		try {
			ui.component.handleInput("ab");
			ui.component.handleInput("\x02"); // Ctrl+B
			ui.component.handleInput(K.space);
			ui.component.handleInput("\x06"); // Ctrl+F
			ui.component.handleInput("c");
			ui.component.handleInput(form ? K.right : K.left);
			assert.ok(!ui.text().includes(CURSOR_MARKER));
			ui.component.handleInput(form ? K.left : K.right);
			assert.ok(ui.text().includes(CURSOR_MARKER));
			ui.component.handleInput("d");
			ui.component.handleInput(K.ctrlEnter);
			if (form) assert.deepEqual(ui.result()?.answers?.[0]?.value, { note: "a bcd" });
			else assert.equal(ui.result()?.answers?.[0]?.freeText, "a bcd");
		} finally { ui.component.dispose(); }
	}
});
