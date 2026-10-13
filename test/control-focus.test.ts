import assert from "node:assert/strict";
import { test } from "node:test";
import { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createDeadline } from "../src/deadline.ts";
import { normalizeAskUserRequest } from "../src/schema.ts";
import { AskUserComponent, type AskUserTheme, type CustomUIResult } from "../src/ui/custom.ts";

/**
 * Focus-indicator coverage for the custom terminal UI.
 *
 * Focus is shown with a `▸` triangle drawn in front of the focused control —
 * the standalone bool side, the single/multi option cursor, or the active
 * simple-form control — exactly like the single-choice cursor. There is no
 * focus background: the check/cross mark marks the selection and is independent
 * of the arrow that marks the focus. These tests drive an ANSI theme that also
 * exposes a `bg` helper, so a regression that reintroduces a focus tint is
 * caught both at the call site (the helper must never run) and in the raw
 * output (no background sequence anywhere).
 */

const K = {
	left: "\x1b[D",
	right: "\x1b[C",
	up: "\x1b[A",
	down: "\x1b[B",
	space: " ",
	enter: "\r",
	tab: "\t",
	shiftTab: "\x1b[Z",
	ctrlEnter: "\x1b[13;5u",
};

const FG: Record<string, string> = {
	accent: "35",
	success: "32",
	error: "31",
	muted: "90",
	warning: "33",
	dim: "2",
	text: "37",
};

/** A theme surface extended with an instrumented `bg` we assert is never used. */
interface InstrumentedTheme extends AskUserTheme {
	bg(color: string, text: string): string;
}

/** Build a theme whose foreground resets are fg-only and whose `bg` records calls. */
function makeTheme(): { theme: InstrumentedTheme; bgCalls: string[] } {
	const bgCalls: string[] = [];
	const theme: InstrumentedTheme = {
		fg: (color, text) => `\x1b[${FG[color] ?? "37"}m${text}\x1b[39m`,
		bold: (text) => `\x1b[1m${text}\x1b[22m`,
		inverse: (text) => `\x1b[7m${text}\x1b[27m`,
		bg: (color, text) => {
			bgCalls.push(color);
			return `\x1b[48;5;236m${text}\x1b[49m`;
		},
	};
	return { theme, bgCalls };
}

const strip = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
/** Number of focus arrows on a rendered line, ignoring ANSI. */
const arrows = (line: string) => (strip(line).match(/▸/g) ?? []).length;

/** Fail if any focus background colour or reset reaches the terminal. */
function assertNoBackground(lines: string[]) {
	for (const line of lines) {
		assert.ok(!line.includes("\x1b[48;"), `background colour leaked: ${JSON.stringify(strip(line))}`);
		assert.ok(!line.includes("\x1b[49m"), `background reset leaked: ${JSON.stringify(strip(line))}`);
	}
}

function mount(
	raw: unknown,
	options: { theme?: AskUserTheme; rows?: number; focus?: boolean } = {},
) {
	let result: CustomUIResult | undefined;
	const component = new AskUserComponent({
		request: normalizeAskUserRequest(raw).request,
		deadline: createDeadline(10_000),
		theme: options.theme ?? makeTheme().theme,
		tui: { requestRender() {}, terminal: { rows: options.rows ?? 24, columns: 120 } },
		done: (value) => { result = value; },
	});
	if (options.focus !== false) component.focused = true;
	return { component, result: () => result };
}

const boolQuestion = (extra: Record<string, unknown> = {}) => ({ questions: [{ title: "Proceed?", kind: "bool", ...extra }] });
const singleQuestion = { questions: [{ title: "Pick", kind: "single", options: [{ label: "Alpha" }, { label: "Beta" }] }] };
const multiQuestion = { questions: [{ title: "Pick", kind: "multi", options: [{ label: "Alpha" }, { label: "Beta" }] }] };
const formQuestion = (fields: Record<string, unknown>[]) => ({ questions: [{ title: "Form", kind: "simple-form", fields }] });

test("standalone bool keeps both sides on one line with the focus arrow separate from the selection mark", () => {
	const { component } = mount(boolQuestion());
	try {
		const unset = component.render(80).find((entry) => entry.includes("True"))!;
		assert.equal(arrows(unset), 1, "exactly one focus arrow");
		assert.match(strip(unset), /▸ \[ \] True\s+\[ \] False \(unset\)/);
		assert.ok(!strip(unset).includes("[✓]") && !strip(unset).includes("[✗]"), "nothing selected yet");

		component.handleInput(K.space); // select the focused True side
		const checked = component.render(80).find((entry) => entry.includes("True"))!;
		assert.match(strip(checked), /▸ \[✓\] True\s+\[ \] False/);
		assert.equal(arrows(checked), 1);

		component.handleInput(K.right); // move focus to False; the ✓ stays on True
		const moved = component.render(80).find((entry) => entry.includes("True"))!;
		assert.match(strip(moved), /\[✓\] True\s+▸ \[ \] False/);
		assert.equal(arrows(moved), 1);

		component.handleInput(K.space); // now select False
		const crossed = component.render(80).find((entry) => entry.includes("True"))!;
		assert.match(strip(crossed), /\[ \] True\s+▸ \[✗\] False/);
		assert.equal(arrows(crossed), 1);
	} finally { component.dispose(); }
});

test("standalone bool default focus lands on the selected side, else True", () => {
	const falseDefault = mount(boolQuestion({ default: false }));
	try {
		const line = falseDefault.component.render(80).find((entry) => entry.includes("True"))!;
		assert.match(strip(line), /\[ \] True\s+▸ \[✗\] False/);
		assert.match(strip(line), /\(default\)/);
	} finally { falseDefault.component.dispose(); }

	const trueDefault = mount(boolQuestion({ default: true }));
	try {
		const line = trueDefault.component.render(80).find((entry) => entry.includes("True"))!;
		assert.match(strip(line), /▸ \[✓\] True\s+\[ \] False/);
		assert.match(strip(line), /\(default\)/);
	} finally { trueDefault.component.dispose(); }
});

test("bool Left/Right move the focus arrow without changing the selection", () => {
	const { component, result } = mount(boolQuestion());
	try {
		component.handleInput(K.right);
		assert.match(strip(component.render(80).join("\n")), /\[ \] True\s+▸ \[ \] False \(unset\)/);
		component.handleInput(K.left);
		assert.match(strip(component.render(80).join("\n")), /▸ \[ \] True\s+\[ \] False \(unset\)/);
		// Up/Down are no-ops for a standalone bool.
		component.handleInput(K.down);
		component.handleInput(K.up);
		assert.match(strip(component.render(80).join("\n")), /▸ \[ \] True\s+\[ \] False \(unset\)/);
		component.handleInput(K.space); // select the focused True side
		component.handleInput(K.ctrlEnter);
		assert.equal(result()?.answers?.[0]?.value, true);
		assert.equal(result()?.answers?.[0]?.usedDefault, false);
	} finally { component.dispose(); }
});

test("bool Enter selects the focused side and continues; Space only selects and never flips", () => {
	const raw = { questions: [{ title: "Bool", kind: "bool" }, { title: "After", kind: "input" }] };
	const { component, result } = mount(raw);
	try {
		assert.match(strip(component.render(80).join("\n")), /1\/2\. Bool/);
		component.handleInput(K.space); // select True (focused) and stay
		assert.equal(result(), undefined);
		assert.match(strip(component.render(80).join("\n")), /1\/2\. Bool/, "Space must not continue");
		assert.match(strip(component.render(80).join("\n")), /▸ \[✓\] True/);
		component.handleInput(K.space); // re-selecting True must not flip it
		assert.match(strip(component.render(80).join("\n")), /▸ \[✓\] True/);
		component.handleInput(K.enter); // select + continue
		assert.match(strip(component.render(80).join("\n")), /2\/2\. After/);
		component.handleInput("done");
		component.handleInput(K.ctrlEnter);
		assert.equal(result()?.answers?.[0]?.value, true);
		assert.equal(result()?.answers?.[0]?.usedDefault, false);
	} finally { component.dispose(); }
});

test("bool with the focus on False selects false from unset, true, and false prior states", () => {
	for (const extra of [{}, { default: true }]) {
		const { component, result } = mount(boolQuestion(extra));
		try {
			component.handleInput(K.right); // focus False, regardless of the prior value
			component.handleInput(K.space);
			component.handleInput(K.space); // idempotent: false stays false
			assert.match(strip(component.render(80).join("\n")), /▸ \[✗\] False/);
			component.handleInput(K.ctrlEnter);
			assert.equal(result()?.answers?.[0]?.value, false);
			assert.equal(result()?.answers?.[0]?.usedDefault, false);
		} finally { component.dispose(); }
	}
	// Already false: the initial focus is on the selected False side.
	const existing = mount(boolQuestion({ default: false }));
	try {
		assert.match(strip(existing.component.render(80).join("\n")), /▸ \[✗\] False/);
		existing.component.handleInput(K.space);
		existing.component.handleInput(K.ctrlEnter);
		assert.equal(existing.result()?.answers?.[0]?.value, false);
	} finally { existing.component.dispose(); }
});

test("no focus background is drawn for bool, single, multi, or simple-form controls", () => {
	const { theme, bgCalls } = makeTheme();
	const raw = { questions: [
		{ title: "Proceed?", kind: "bool" },
		{ title: "Pick", kind: "single", options: [{ label: "Alpha" }, { label: "Beta" }] },
		{ title: "Scope", kind: "multi", options: [{ label: "Alpha" }, { label: "Beta" }] },
		{ title: "Form", kind: "simple-form", fields: [
			{ name: "ok", label: "OK", kind: "bool" },
			{ name: "target", label: "Target", kind: "single", options: [{ label: "Alpha" }, { label: "Beta" }] },
			{ name: "checks", label: "Checks", kind: "multi", options: [{ label: "Alpha" }] },
		] },
	] };
	const { component } = mount(raw, { theme });
	try {
		for (const width of [20, 40, 80, 120]) assertNoBackground(component.render(width));
		for (let step = 0; step < 4; step += 1) {
			component.handleInput(K.tab);
			assertNoBackground(component.render(80));
		}
		component.handleInput(K.tab); // wrap back to the bool tab
		component.handleInput(K.right);
		component.handleInput(K.space);
		assertNoBackground(component.render(80));
		assert.deepEqual(bgCalls, [], "the background helper must never be called");
	} finally { component.dispose(); }
});

test("single and multi focused options keep the arrow cursor and get no background", () => {
	const single = mount(singleQuestion);
	try {
		assert.match(strip(single.component.render(80).join("\n")), /  ▸ ○ 1\. Alpha/);
		assertNoBackground(single.component.render(80));
		single.component.handleInput(K.down);
		assert.match(strip(single.component.render(80).join("\n")), /  ▸ ○ 2\. Beta/);
		assertNoBackground(single.component.render(80));
	} finally { single.component.dispose(); }

	const multi = mount(multiQuestion);
	try {
		assert.match(strip(multi.component.render(80).join("\n")), /  ▸ ▢ 1\. Alpha/);
		assertNoBackground(multi.component.render(80));
		multi.component.handleInput(K.down);
		assert.match(strip(multi.component.render(80).join("\n")), /  ▸ ▢ 2\. Beta/);
		assertNoBackground(multi.component.render(80));
	} finally { multi.component.dispose(); }
});

test("simple-form bool and choices use the arrow focus with no background", () => {
	const { component } = mount(formQuestion([
		{ name: "ok", label: "OK", kind: "bool" },
		{ name: "target", label: "Target", kind: "single", options: [{ label: "Alpha" }, { label: "Beta" }] },
		{ name: "checks", label: "Checks", kind: "multi", options: [{ label: "Alpha" }, { label: "Beta" }] },
	]));
	try {
		assert.match(strip(component.render(80).join("\n")), /    ▸ \[ \] True\s+\[ \] False/);
		assertNoBackground(component.render(80));

		// Space selects the focused bool side and stays on the field.
		component.handleInput(K.space);
		let text = strip(component.render(80).join("\n"));
		assert.match(text, /    ▸ \[✓\] True/);
		assert.match(text, /▸ OK/, "Space must not advance the form field");
		component.handleInput(K.right);
		component.handleInput(K.space);
		assert.match(strip(component.render(80).join("\n")), /▸ \[✗\] False/);
		assertNoBackground(component.render(80));

		// Enter selects the focused side and advances to the single field.
		component.handleInput(K.enter);
		text = strip(component.render(80).join("\n"));
		assert.match(text, /▸ Target/);
		assert.match(text, /    ▸ ○ Alpha/);
		assertNoBackground(component.render(80));

		// Down walks the single cursor, then leaves for the multi field.
		component.handleInput(K.down);
		assert.match(strip(component.render(80).join("\n")), /    ▸ ○ Beta/);
		component.handleInput(K.down);
		text = strip(component.render(80).join("\n"));
		assert.match(text, /▸ Checks/);
		assert.match(text, /    ▸ ▢ Alpha/);
		assertNoBackground(component.render(80));
	} finally { component.dispose(); }
});

test("simple-form bool Left/Right move the internal focus while Up/Down leave the field", () => {
	const { component } = mount(formQuestion([
		{ name: "ok", label: "OK", kind: "bool" },
		{ name: "note", label: "Note", kind: "input" },
	]));
	try {
		assert.match(strip(component.render(80).join("\n")), /    ▸ \[ \] True\s+\[ \] False/);
		component.handleInput(K.right);
		assert.match(strip(component.render(80).join("\n")), /\[ \] True\s+▸ \[ \] False/);
		component.handleInput(K.right); // boundary: leave the bool field for the input
		let text = strip(component.render(80).join("\n"));
		assert.match(text, /▸ Note/);
		assert.ok(!text.includes("▸ [ ]"), "the bool field is no longer active");
		component.handleInput(K.up); // returns to the bool field, focus retained
		assert.match(strip(component.render(80).join("\n")), /\[ \] True\s+▸ \[ \] False/);
		component.handleInput(K.down); // leaves again
		assert.match(strip(component.render(80).join("\n")), /▸ Note/);
		component.handleInput(K.up);
		assert.match(strip(component.render(80).join("\n")), /\[ \] True\s+▸ \[ \] False/);
	} finally { component.dispose(); }
});

test("every question kind and bool focus stay within the width with no background", () => {
	const raw = { questions: [
		{ title: "Proceed?", kind: "bool" },
		{ title: "Pick", kind: "single", options: [{ label: "Alpha" }, { label: "Beta" }] },
		{ title: "Scope", kind: "multi", options: [{ label: "unit" }, { label: "integration" }] },
		{ title: "Form", kind: "simple-form", fields: [
			{ name: "ok", label: "OK", kind: "bool" },
			{ name: "target", label: "Target", kind: "single", options: [{ label: "staging" }, { label: "prod" }] },
			{ name: "checks", label: "Checks", kind: "multi", options: [{ label: "unit" }] },
		] },
	] };

	const check = (label: string, width: number, lines: string[]) => {
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= width, `${label} @${width}: overflow ${JSON.stringify(strip(line))}`);
		}
		assertNoBackground(lines);
	};

	for (const width of [16, 20, 30, 40, 80, 120]) {
		const { component } = mount(raw);
		try {
			check("bool focus True", width, component.render(width));
			component.handleInput(K.right);
			check("bool focus False", width, component.render(width));
			component.handleInput(K.space);
			component.handleInput(K.space);
			check("bool selected False", width, component.render(width));

			component.handleInput(K.tab);
			assert.match(strip(component.render(width).join("\n")), /2\/4\. Pick/, "must be on the single tab");
			check("single option 1", width, component.render(width));
			component.handleInput(K.down);
			check("single option 2", width, component.render(width));

			component.handleInput(K.tab);
			assert.match(strip(component.render(width).join("\n")), /3\/4\. Scope/, "must be on the multi tab");
			check("multi option 1", width, component.render(width));
			component.handleInput(K.down);
			check("multi option 2", width, component.render(width));

			component.handleInput(K.tab);
			assert.match(strip(component.render(width).join("\n")), /4\/4\. Form/, "must be on the form tab");
			for (let step = 0; step < 6; step += 1) {
				check(`form step ${step}`, width, component.render(width));
				component.handleInput(K.down);
			}

			component.handleInput(K.tab);
			assert.match(strip(component.render(width).join("\n")), /Review/);
			check("review", width, component.render(width));
		} finally { component.dispose(); }
	}
});

/**
 * A real Pi `Theme` still drives the arrow focus, and its `selectedBg` token
 * must not appear anywhere behind the focused controls.
 */
test("a real Pi Theme draws no background behind the focused controls", () => {
	const palette = {
		text: "#d7d9e0", muted: "#9aa0b0", dim: "#7f859a", accent: "#b18ae0", border: "#8f8fd8",
		success: "#7fd6a3", error: "#e08a7a", warning: "#d6d47f", thinkingXhigh: "#e08ab0",
	};
	const theme = new Theme(palette as never, { selectedBg: "#1e2740" } as never, "truecolor");
	const selectedBg = theme.getBgAnsi("selectedBg");
	const accent = theme.getFgAnsi("accent");

	const bool = mount(boolQuestion({ default: true }), { theme });
	try {
		const line = bool.component.render(80).find((entry) => entry.includes("True"))!;
		assert.ok(!line.includes(selectedBg), "the selectedBg tint must not appear");
		assert.ok(!line.includes("\x1b[48;"), "no background colour on the bool control");
		assert.match(strip(line), /▸ \[✓\] True/);
		assert.ok(line.includes(accent), "the focus arrow keeps the accent colour");
	} finally { bool.component.dispose(); }

	const single = mount(singleQuestion, { theme });
	try {
		const line = single.component.render(80).find((entry) => entry.includes("Alpha"))!;
		assert.ok(!line.includes(selectedBg), "the selectedBg tint must not appear");
		assert.ok(!line.includes("\x1b[48;"), "no background colour on the option row");
		assert.match(strip(line), /  ▸ ○ 1\. Alpha/);
	} finally { single.component.dispose(); }
});
