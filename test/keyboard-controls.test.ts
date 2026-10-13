import assert from "node:assert/strict";
import { test } from "node:test";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { createDeadline } from "../src/deadline.ts";
import { normalizeAskUserRequest } from "../src/schema.ts";
import { AskUserComponent, type CustomUIResult } from "../src/ui/custom.ts";

const K = { up: "\x1b[A", down: "\x1b[B", left: "\x1b[D", right: "\x1b[C", enter: "\r", space: " ", tab: "\t", shiftTab: "\x1b[Z", ctrlEnter: "\x1b[13;5u" };
const choices = [{ label: "A" }, { label: "B" }];

function mount(raw: unknown) {
	let result: CustomUIResult | undefined;
	const component = new AskUserComponent({
		request: normalizeAskUserRequest(raw).request,
		deadline: createDeadline(10_000),
		theme: { fg: (_color, text) => text, bold: (text) => text },
		tui: { requestRender() {}, terminal: { rows: 24, columns: 160 } },
		done: (value) => { result = value; },
	});
	component.focused = true;
	return { component, result: () => result, text: () => component.render(160).join("\n") };
}

for (const displayMode of ["overlay", "inline"]) {
	for (const initial of [undefined, false, true]) {
		test(`${displayMode}: bool Space selects the focused side without continuing; Enter selects and advances (${initial})`, () => {
			const ui = mount({ displayMode, questions: [
				{ title: "Bool", kind: "bool", ...(initial === undefined ? {} : { default: initial }) },
				{ title: "After", kind: "input" },
			] });
			try {
				assert.match(ui.text(), /Enter select & next/);
				// Default focus is the selected side, else True.
				assert.match(ui.text(), initial === false ? /▸ \[[✗ ]\] False/ : /▸ \[[✓ ]\] True/);
				const selected = initial === undefined ? true : initial;
				ui.component.handleInput(K.space); // select the focused side, no continue
				assert.equal(ui.result(), undefined);
				assert.match(ui.text(), /1\/2\. Bool/);
				assert.match(ui.text(), selected ? /▸ \[✓\] True/ : /▸ \[✗\] False/);
				assert.doesNotMatch(ui.text(), /\(default\)|\(unset\)/);
				ui.component.handleInput(K.space); // re-selecting never flips it
				assert.match(ui.text(), selected ? /▸ \[✓\] True/ : /▸ \[✗\] False/);
				ui.component.handleInput(K.enter); // select the focused side + continue
				assert.match(ui.text(), /2\/2\. After/);
				ui.component.handleInput("ready");
				ui.component.handleInput(K.enter);
				assert.match(ui.text(), /Review before submitting/);
				ui.component.handleInput(K.enter);
				assert.equal(ui.result()?.answers?.[0]?.value, selected);
				assert.equal(ui.result()?.answers?.[0]?.usedDefault, false);
			} finally { ui.component.dispose(); }
		});

		test(`${displayMode}: bool arrows move only the focus arrow, never the value (${initial})`, () => {
			const ui = mount({ displayMode, questions: [{ title: "Bool", kind: "bool", ...(initial === undefined ? {} : { default: initial }) }] });
			try {
				assert.match(ui.text(), initial === false ? /▸ \[[✗ ]\] False/ : /▸ \[[✓ ]\] True/);
				const before = ui.text();
				for (const key of [K.up, K.down, "\x10", "\x0e"]) {
					ui.component.handleInput(key);
					assert.equal(ui.text(), before, "non-horizontal keys must not change a standalone bool");
				}
				ui.component.handleInput(K.left); // boundary when already on True
				ui.component.handleInput(K.right); // now deterministically on False
				assert.match(ui.text(), /▸ \[[✓✗ ]\] False/);
				ui.component.handleInput(K.left);
				assert.match(ui.text(), /▸ \[[✓✗ ]\] True/);
				assert.equal(ui.result(), undefined, "navigation must not submit");
			} finally { ui.component.dispose(); }
		});
	}

	for (const allowFreeText of [false, true]) {
		test(`${displayMode}: single, free text ${allowFreeText}: Space stays and Enter selects and continues`, () => {
			const ui = mount({ displayMode, allowFreeText, questions: [
				{ title: "Choice", kind: "single", options: choices },
				{ title: "After", kind: "input" },
			] });
			try {
				ui.component.handleInput(K.right);
				assert.match(ui.text(), /▸ ○ 2\. B/);
				ui.component.handleInput(K.space);
				ui.component.handleInput(K.space); // single selection is idempotent
				assert.equal(ui.result(), undefined);
				assert.match(ui.text(), /▸ ◉ 2\. B/);
				assert.match(ui.text(), /Enter select & next/);
				ui.component.handleInput(K.left);
				ui.component.handleInput(K.enter);
				assert.match(ui.text(), /2\/2\. After/);
				ui.component.handleInput("ready");
				ui.component.handleInput(K.enter);
				assert.match(ui.text(), /Review before submitting/);
				ui.component.handleInput(K.enter);
				assert.deepEqual(ui.result()?.answers?.[0]?.selections, ["A"]);
			} finally { ui.component.dispose(); }
		});

		test(`${displayMode}: multi, free text ${allowFreeText}: Enter and Space toggle without advancing`, () => {
			const ui = mount({ displayMode, allowFreeText, questions: [{ title: "Choice", kind: "multi", options: choices }] });
			try {
				ui.component.handleInput(K.right);
				ui.component.handleInput(K.enter);
				assert.equal(ui.result(), undefined);
				assert.match(ui.text(), /▸ ▣ 2\. B/);
				assert.match(ui.text(), /Enter\/Space toggle/);
				ui.component.handleInput(K.space);
				ui.component.handleInput(K.enter);
				ui.component.handleInput(K.left);
				ui.component.handleInput(K.enter);
				assert.match(ui.text(), /▸ ▣ 1\. A/);
				ui.component.handleInput(K.enter);
				assert.equal(ui.result(), undefined);
				ui.component.handleInput(K.ctrlEnter);
				assert.deepEqual(ui.result()?.answers?.[0]?.selections, ["B"]);
			} finally { ui.component.dispose(); }
		});
	}

	test(`${displayMode}: form vertical arrows traverse controls without editing defaults`, () => {
		const ui = mount({ displayMode, questions: [{ title: "Form", kind: "simple-form", fields: [
			{ name: "bool", label: "Bool", kind: "bool", default: false },
			{ name: "text", label: "Text", kind: "input", default: "seed" },
			{ name: "single", label: "Single", kind: "single", options: choices, default: "B" },
			{ name: "multi", label: "Multi", kind: "multi", options: choices, default: ["A"] },
		] }] });
		try {
			ui.component.handleInput(K.up);
			assert.match(ui.text(), /▸ Bool/);
			ui.component.handleInput(K.down);
			assert.match(ui.text(), /▸ Text/);
			assert.ok(ui.text().includes(CURSOR_MARKER));
			ui.component.handleInput(K.down);
			assert.match(ui.text(), /▸ Single/);
			assert.match(ui.text(), /▸ ○ A/);
			assert.ok(!ui.text().includes(CURSOR_MARKER));
			ui.component.handleInput(K.right); // horizontal navigation still works outside text
			assert.match(ui.text(), /▸ ◉ B/);
			ui.component.handleInput(K.down);
			assert.match(ui.text(), /▸ Multi/);
			assert.match(ui.text(), /▸ ▣ A/);
			ui.component.handleInput(K.right);
			assert.match(ui.text(), /▸ ▢ B/);
			ui.component.handleInput(K.down);
			ui.component.handleInput(K.down); // end boundary
			assert.match(ui.text(), /▸ \[ Enter Submit \]/);
			ui.component.handleInput(K.left);
			assert.match(ui.text(), /▸ Multi/);
			assert.match(ui.text(), /▸ ▢ B/);
			for (let i = 0; i < 4; i++) ui.component.handleInput(K.up);
			assert.match(ui.text(), /▸ Text/);
			ui.component.handleInput(K.up);
			assert.match(ui.text(), /▸ Bool/);
			ui.component.handleInput(K.ctrlEnter);
			assert.deepEqual(ui.result()?.answers?.[0]?.value, { bool: false, text: "seed", single: "B", multi: ["A"] });
			assert.equal(ui.result()?.answers?.[0]?.usedDefault, true);
		} finally { ui.component.dispose(); }
	});

	test(`${displayMode}: form Enter advances bool/single, but multi keeps focus`, () => {
		const ui = mount({ displayMode, questions: [{ title: "Form", kind: "simple-form", fields: [
			{ name: "bool", label: "Bool", kind: "bool", default: true },
			{ name: "single", label: "Single", kind: "single", options: choices, default: "B" },
			{ name: "multi", label: "Multi", kind: "multi", options: choices, default: ["A"] },
			{ name: "untouched", label: "Untouched", kind: "bool" },
		] }] });
		try {
			assert.match(ui.text(), /Enter select & next/);
			ui.component.handleInput(K.right); // move the bool focus off the true default
			ui.component.handleInput(K.space); // select False, staying on the field
			assert.match(ui.text(), /▸ Bool/);
			assert.match(ui.text(), /▸ \[✗\] False/);
			ui.component.handleInput(K.enter); // select False (already focused) + advance
			assert.match(ui.text(), /▸ Single/);
			assert.match(ui.text(), /Enter select & next/);
			ui.component.handleInput(K.left); // focus A
			ui.component.handleInput(K.space);
			assert.match(ui.text(), /▸ ◉ A/);
			ui.component.handleInput(K.enter);
			assert.match(ui.text(), /▸ Multi/);
			ui.component.handleInput(K.enter); // deselect default A
			assert.match(ui.text(), /▸ ▢ A/);
			ui.component.handleInput(K.down);
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
		test(`${displayMode}: Enter answers required form ${kind}; the action button still submits`, () => {
			const ui = mount({ displayMode, questions: [{ title: "Form", kind: "simple-form", fields: [
				{ name: "required", label: "Required", kind, required: true, ...(kind === "bool" ? {} : { options: choices }) },
			] }] });
			try {
				ui.component.handleInput(K.ctrlEnter);
				assert.equal(ui.result(), undefined);
				assert.match(ui.text(), /required field/);
				ui.component.handleInput(K.enter);
				assert.equal(ui.result(), undefined);
				assert.doesNotMatch(ui.text(), /required field/);
				if (kind === "multi") {
					assert.match(ui.text(), /▸ Required/);
					ui.component.handleInput(K.down);
					ui.component.handleInput(K.down);
				}
				assert.match(ui.text(), /▸ \[ Enter Submit \]/);
				ui.component.handleInput(K.enter);
				assert.deepEqual(ui.result()?.answers?.[0]?.value, { required: kind === "bool" ? true : kind === "single" ? "A" : ["A"] });
			} finally { ui.component.dispose(); }
		});
	}

	test(`${displayMode}: form JSON default cursor movement preserves provenance and allows insertion`, () => {
		for (const edited of [false, true]) {
			const ui = mount({ displayMode, questions: [{ title: "Mounts", kind: "simple-form", fields: [
				{ name: "mounts", label: "Mounts JSON", kind: "input", default: "[]" },
				{ name: "network", label: "Host network", kind: "bool" },
			] }] });
			try {
				ui.component.handleInput(K.left); // start boundary must not change field
				ui.component.handleInput(K.right);
				ui.component.handleInput(K.right);
				ui.component.handleInput(K.right); // end boundary must not change field
				ui.component.handleInput(K.left);
				assert.match(ui.text(), /▸ Mounts JSON \(default\)/);
				assert.ok(ui.text().includes(CURSOR_MARKER));
				if (edited) ui.component.handleInput("{}");
				ui.component.handleInput(K.ctrlEnter);
				assert.deepEqual(ui.result()?.answers?.[0]?.value, { mounts: edited ? "[{}]" : "[]" });
				assert.equal(ui.result()?.answers?.[0]?.usedDefault, !edited);
			} finally { ui.component.dispose(); }
		}
	});

	test(`${displayMode}: left/right respects Chinese and emoji graphemes in text`, () => {
		const ui = mount({ displayMode, questions: [{ title: "Text", kind: "input" }] });
		try {
			ui.component.handleInput("中👨‍👩‍👧‍👦文");
			ui.component.handleInput(K.left);
			ui.component.handleInput(K.left);
			ui.component.handleInput("a");
			ui.component.handleInput(K.right);
			ui.component.handleInput("b");
			ui.component.handleInput(K.enter);
			assert.equal(ui.result()?.answers?.[0]?.freeText, "中a👨‍👩‍👧‍👦b文");
		} finally { ui.component.dispose(); }
	});

	for (const kind of ["input", "single", "multi", "simple-form"]) {
		test(`${displayMode}: ${kind} text left/right edit the cursor, up/down move focus`, () => {
			const form = kind === "simple-form";
			const ui = mount({ displayMode, questions: [form
				? { title: "Form", kind, fields: [{ name: "note", label: "Note", kind: "input" }, { name: "bool", label: "Bool", kind: "bool" }] }
				: { title: "Text", kind, ...(kind === "input" ? {} : { options: choices }) }] });
			try {
				ui.component.handleInput("ab");
				ui.component.handleInput(K.right); // end boundary must not leave text
				ui.component.handleInput(K.left);
				assert.ok(ui.text().includes(CURSOR_MARKER));
				assert.match(ui.text(), /←\/→ cursor/);
				ui.component.handleInput(K.space);
				ui.component.handleInput(K.right);
				ui.component.handleInput("c");
				ui.component.handleInput("\x02"); // Ctrl+B still works
				ui.component.handleInput("\x06"); // Ctrl+F still works
				if (kind !== "input") {
					ui.component.handleInput(form ? K.down : K.up);
					assert.ok(!ui.text().includes(CURSOR_MARKER));
					ui.component.handleInput(form ? K.up : K.down);
					assert.ok(ui.text().includes(CURSOR_MARKER));
				}
				ui.component.handleInput("d");
				ui.component.handleInput(K.ctrlEnter);
				if (form) assert.deepEqual(ui.result()?.answers?.[0]?.value, { note: "a bcd" });
				else assert.equal(ui.result()?.answers?.[0]?.freeText, "a bcd");
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
