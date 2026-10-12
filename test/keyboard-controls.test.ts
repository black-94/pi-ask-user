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
				assert.match(before, /Enter\/Space toggle/);
				ui.component.handleInput(K.enter);
				assert.equal(ui.result(), undefined, "Enter toggles without submitting");
				const next = initial === undefined ? true : !initial;
				assert.match(ui.text(), next ? /\[✓\] True/ : /\[✗\] False/);
				assert.doesNotMatch(ui.text(), /\(default\)|\(unset\)/);
				ui.component.handleInput(K.enter);
				assert.equal(ui.result(), undefined);
				assert.match(ui.text(), !next ? /\[✓\] True/ : /\[✗\] False/);
				ui.component.handleInput(K.ctrlEnter);
				assert.equal(ui.result()?.answers?.[0]?.value, !next);
				assert.equal(ui.result()?.answers?.[0]?.usedDefault, false);
			} finally { ui.component.dispose(); }
		});
	}

	for (const kind of ["single", "multi"]) {
		for (const allowFreeText of [false, true]) {
			test(`${displayMode}: ${kind}, free text ${allowFreeText}: Enter edits the focused option without submitting`, () => {
				const ui = mount({ displayMode, allowFreeText, questions: [{ title: "Choice", kind, options: choices }] });
				try {
					ui.component.handleInput(K.right);
					assert.match(ui.text(), /▸ [○▢] 2\. B/);
					ui.component.handleInput(K.enter);
					assert.equal(ui.result(), undefined);
					assert.match(ui.text(), /▸ [◉▣] 2\. B/);
					assert.match(ui.text(), kind === "multi" ? /Enter\/Space toggle/ : /Enter\/Space select/);
					ui.component.handleInput(K.space);
					ui.component.handleInput(K.enter); // single stays selected; multi is selected again
					ui.component.handleInput(K.left);
					assert.match(ui.text(), /▸ [○▢] 1\. A/);
					assert.match(ui.text(), /[◉▣] 2\. B/);
					ui.component.handleInput(K.enter);
					assert.equal(ui.result(), undefined);
					assert.match(ui.text(), /▸ [◉▣] 1\. A/);
					ui.component.handleInput(K.enter); // single is idempotent; multi deselects A
					assert.equal(ui.result(), undefined);
					ui.component.handleInput(K.ctrlEnter);
					assert.equal(ui.result()?.kind, "submitted");
					assert.deepEqual(ui.result()?.answers?.[0]?.selections, kind === "single" ? ["A"] : ["B"]);
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

for (const displayMode of ["overlay", "inline"]) {
	test(`${displayMode}: form Enter edits bool/single/multi defaults and keeps focus`, () => {
		const ui = mount({ displayMode, questions: [{ title: "Form", kind: "simple-form", fields: [
			{ name: "bool", label: "Bool", kind: "bool", default: false },
			{ name: "single", label: "Single", kind: "single", options: choices, default: "B" },
			{ name: "multi", label: "Multi", kind: "multi", options: choices, default: ["A"] },
			{ name: "untouched", label: "Untouched", kind: "bool" },
		] }] });
		try {
			ui.component.handleInput(K.enter);
			assert.match(ui.text(), /▸ Bool/);
			assert.match(ui.text(), /\[✓\] True/);
			assert.match(ui.text(), /Enter\/Space toggle/);
			ui.component.handleInput(K.enter);
			assert.match(ui.text(), /\[✗\] False/);
			ui.component.handleInput(K.down); // Single A
			ui.component.handleInput(K.enter);
			assert.match(ui.text(), /▸ ◉ A/);
			assert.match(ui.text(), /Enter\/Space select/);
			ui.component.handleInput(K.enter); // single does not deselect
			assert.match(ui.text(), /▸ ◉ A/);
			ui.component.handleInput(K.down); // Single B
			ui.component.handleInput(K.down); // Multi A
			ui.component.handleInput(K.enter); // deselect default A
			assert.match(ui.text(), /▸ ▢ A/);
			ui.component.handleInput(K.down); // Multi B
			ui.component.handleInput(K.enter);
			assert.match(ui.text(), /▸ ▣ B/);
			ui.component.handleInput(K.enter);
			assert.match(ui.text(), /▸ ▢ B/);
			assert.equal(ui.result(), undefined);
			ui.component.handleInput(K.ctrlEnter);
			assert.deepEqual(ui.result()?.answers?.[0]?.value, { bool: false, single: "A", multi: [] });
			assert.equal(ui.result()?.answers?.[0]?.usedDefault, false);
		} finally { ui.component.dispose(); }
	});

	for (const kind of ["bool", "single", "multi"]) {
		test(`${displayMode}: Enter answers an unset required form ${kind}, then the button submits`, () => {
			const ui = mount({ displayMode, questions: [{ title: "Form", kind: "simple-form", fields: [
				{ name: "required", label: "Required", kind, required: true, ...(kind === "bool" ? {} : { options: choices }) },
			] }] });
			try {
				ui.component.handleInput(K.ctrlEnter);
				assert.equal(ui.result(), undefined);
				assert.match(ui.text(), /required field/);
				ui.component.handleInput(K.enter);
				assert.equal(ui.result(), undefined);
				assert.match(ui.text(), /▸ Required/);
				assert.doesNotMatch(ui.text(), /required field/);
				if (kind !== "bool") ui.component.handleInput(K.down); // second option
				ui.component.handleInput(K.down); // button
				assert.match(ui.text(), /▸ \[ Enter Submit \]/);
				ui.component.handleInput(K.enter);
				assert.deepEqual(ui.result()?.answers?.[0]?.value, { required: kind === "bool" ? true : kind === "single" ? "A" : ["A"] });
			} finally { ui.component.dispose(); }
		});
	}
}

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
