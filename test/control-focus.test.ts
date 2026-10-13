import assert from "node:assert/strict";
import { test } from "node:test";
import { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createDeadline } from "../src/deadline.ts";
import { normalizeAskUserRequest } from "../src/schema.ts";
import { AskUserComponent, type AskUserTheme, type CustomUIResult } from "../src/ui/custom.ts";

/**
 * Focus highlight coverage for the custom terminal UI.
 *
 * The focused control region is tinted with the theme's `selectedBg` token
 * (`FOCUS_BG_TOKEN`) so the tint adapts to light/dark palettes and keeps the
 * foreground readable. These tests use an ANSI theme with a distinctive
 * background sequence so we can prove that only the focused region is tinted,
 * that blur removes it, and that focus stays independent from the selection.
 */

const K = {
	left: "\x1b[D",
	right: "\x1b[C",
	up: "\x1b[A",
	down: "\x1b[B",
	space: " ",
	enter: "\r",
	tab: "\t",
	ctrlEnter: "\x1b[13;5u",
};

const BG = { dark: "\x1b[48;5;236m", light: "\x1b[48;5;253m" } as const;
const FG: Record<string, string> = {
	accent: "35",
	success: "32",
	error: "31",
	muted: "90",
	warning: "33",
	dim: "2",
	text: "37",
};

/** Theme whose foreground resets are fg-only, so a background survives `fg()`. */
function makeTheme(appearance: "light" | "dark"): AskUserTheme {
	return {
		fg: (color, text) => `\x1b[${FG[color] ?? "37"}m${text}\x1b[39m`,
		bold: (text) => `\x1b[1m${text}\x1b[22m`,
		inverse: (text) => `\x1b[7m${text}\x1b[27m`,
		bg: (color, text) => (color === "selectedBg" ? `${BG[appearance]}${text}\x1b[49m` : text),
	};
}

const strip = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");

/** Plain text of every region wrapped by the given focus background sequence. */
function focusRegions(lines: string[], bg: string): string[] {
	const regions: string[] = [];
	for (const line of lines) {
		let index = line.indexOf(bg);
		while (index !== -1) {
			const rest = line.slice(index + bg.length);
			const end = rest.indexOf("\x1b[49m");
			regions.push(strip(end === -1 ? rest : rest.slice(0, end)));
			index = line.indexOf(bg, index + bg.length);
		}
	}
	return regions;
}

/**
 * Fail if a focus background opens without a matching reset (`\x1b[49m`, or the
 * full reset `\x1b[0m` the width truncator may append), or if a foreground opens
 * without a reset (`\x1b[39m`/`\x1b[0m`). This catches the focus tint or a color
 * leaking past its region, especially after truncation at narrow widths.
 */
function assertNoStyleLeak(line: string, bg: string) {
	const opens = line.split(bg).length - 1;
	if (opens > 0) {
		const lastOpen = line.lastIndexOf(bg);
		assert.ok(/\x1b\[(49|0)m/.test(line.slice(lastOpen)), `unclosed focus background: ${JSON.stringify(strip(line))}`);
	}
	const fgOpens = (line.match(/\x1b\[38;[0-9;]*m/g) ?? []).length;
	const resets = (line.match(/\x1b\[(?:39|0)m/g) ?? []).length;
	assert.ok(resets >= fgOpens, `unclosed foreground: ${JSON.stringify(strip(line))}`);
}

function mount(
	raw: unknown,
	options: { theme?: AskUserTheme; rows?: number; focus?: boolean } = {},
) {
	let result: CustomUIResult | undefined;
	const component = new AskUserComponent({
		request: normalizeAskUserRequest(raw).request,
		deadline: createDeadline(10_000),
		theme: options.theme ?? makeTheme("dark"),
		tui: { requestRender() {}, terminal: { rows: options.rows ?? 24, columns: 120 } },
		done: (value) => { result = value; },
	});
	if (options.focus !== false) component.focused = true;
	return { component, result: () => result };
}

const boolQuestion = (extra: Record<string, unknown> = {}) => ({ questions: [{ title: "Proceed?", kind: "bool", ...extra }] });
const singleQuestion = { questions: [{ title: "Pick", kind: "single", options: [{ label: "Alpha" }, { label: "Beta" }] }] };
const multiQuestion = { questions: [{ title: "Pick", kind: "multi", options: [{ label: "Alpha" }, { label: "Beta" }] }] };
const formQuestion = (field: Record<string, unknown>) => ({ questions: [{ title: "Form", kind: "simple-form", fields: [field] }] });

test("standalone bool renders True and False side by side, marked only when selected", () => {
	const { component } = mount(boolQuestion());
	try {
		const unset = strip(component.render(80).join("\n"));
		assert.match(unset, /\[ \] True\s+\[ \] False \(unset\)/);
		assert.doesNotMatch(unset, /\[✓\]|\[✗\]/);

		component.handleInput(K.space);
		const checked = strip(component.render(80).join("\n"));
		assert.match(checked, /\[✓\] True\s+\[ \] False/);
		assert.doesNotMatch(checked, /\[✗\] False/);

		component.handleInput(K.space);
		const crossed = strip(component.render(80).join("\n"));
		assert.match(crossed, /\[ \] True\s+\[✗\] False/);
		assert.doesNotMatch(crossed, /\[✓\] True/);
	} finally { component.dispose(); }
});

test("bool focus background marks only the focused side and is independent of the selection", () => {
	const { component } = mount(boolQuestion({ default: true }));
	try {
		const first = component.render(80);
		assert.deepEqual(focusRegions(first, BG.dark), ["[✓] True"]);

		// Move focus to the unselected side: the tint follows the focus, the check
		// stays on the selected side.
		component.handleInput(K.right);
		const second = component.render(80);
		assert.deepEqual(focusRegions(second, BG.dark), ["[ ] False"]);
		assert.match(strip(second.join("\n")), /\[✓\] True\s+\[ \] False/);
	} finally { component.dispose(); }
});

test("bool focus background is removed when the component loses focus", () => {
	const { component } = mount(boolQuestion({ default: true }));
	try {
		assert.equal(focusRegions(component.render(80), BG.dark).length, 1);
		component.focused = false;
		assert.deepEqual(focusRegions(component.render(80), BG.dark), []);
		// The selection is still rendered without any focus tint.
		assert.match(strip(component.render(80).join("\n")), /\[✓\] True/);
	} finally { component.dispose(); }
});

test("bool Left/Right move focus without changing the value; Space still toggles", () => {
	const { component, result } = mount(boolQuestion());
	try {
		component.handleInput(K.right);
		// Focus moved but nothing is selected yet.
		assert.deepEqual(focusRegions(component.render(80), BG.dark), ["[ ] False"]);
		assert.match(strip(component.render(80).join("\n")), /\[ \] True\s+\[ \] False \(unset\)/);

		component.handleInput(K.space);
		component.handleInput(K.ctrlEnter);
		assert.equal(result()?.kind, "submitted");
		assert.equal(result()?.answers?.[0]?.value, true);
		assert.equal(result()?.answers?.[0]?.usedDefault, false);
	} finally { component.dispose(); }
});

test("single and multi focused options get a subtle background that blur removes", () => {
	const single = mount(singleQuestion);
	try {
		assert.deepEqual(focusRegions(single.component.render(80), BG.dark), ["  ▸ ○ 1. Alpha"]);
		single.component.handleInput(K.down);
		assert.deepEqual(focusRegions(single.component.render(80), BG.dark), ["  ▸ ○ 2. Beta"]);
		single.component.focused = false;
		assert.deepEqual(focusRegions(single.component.render(80), BG.dark), []);
	} finally { single.component.dispose(); }

	const multi = mount(multiQuestion);
	try {
		assert.deepEqual(focusRegions(multi.component.render(80), BG.dark), ["  ▸ ▢ 1. Alpha"]);
		multi.component.handleInput(K.down);
		assert.deepEqual(focusRegions(multi.component.render(80), BG.dark), ["  ▸ ▢ 2. Beta"]);
		multi.component.focused = false;
		assert.deepEqual(focusRegions(multi.component.render(80), BG.dark), []);
	} finally { multi.component.dispose(); }
});

test("simple-form bool/single/multi focus backgrounds match standalone questions", () => {
	const bool = mount(formQuestion({ name: "ok", label: "OK", kind: "bool" }));
	try {
		assert.deepEqual(focusRegions(bool.component.render(80), BG.dark), ["[ ] True"]);
	} finally { bool.component.dispose(); }

	const single = mount(formQuestion({ name: "target", label: "Target", kind: "single", options: [{ label: "Alpha" }, { label: "Beta" }] }));
	try {
		assert.deepEqual(focusRegions(single.component.render(80), BG.dark), ["    ▸ ○ Alpha"]);
	} finally { single.component.dispose(); }

	const multi = mount(formQuestion({ name: "checks", label: "Checks", kind: "multi", options: [{ label: "Alpha" }, { label: "Beta" }] }));
	try {
		assert.deepEqual(focusRegions(multi.component.render(80), BG.dark), ["    ▸ ▢ Alpha"]);
	} finally { multi.component.dispose(); }
});

test("focus backgrounds adapt to light and dark themes without masking foreground colors", () => {
	for (const appearance of ["dark", "light"] as const) {
		const theme = makeTheme(appearance);
		const { component } = mount(boolQuestion({ default: true }), { theme });
		try {
			const line = component.render(80).find((entry) => entry.includes("True"))!;
			assert.ok(line.includes(BG[appearance]), `${appearance}: focus background missing`);
			assert.ok(line.includes("\x1b[32m"), `${appearance}: selected True keeps its success color`);
			assert.match(strip(line), /\[✓\] True/);
		} finally { component.dispose(); }

		const single = mount(singleQuestion, { theme });
		try {
			const line = single.component.render(80).find((entry) => entry.includes("Alpha"))!;
			assert.ok(line.includes(BG[appearance]), `${appearance}: option focus background missing`);
			assert.ok(line.includes("\x1b[35m"), `${appearance}: focused option keeps its accent color`);
		} finally { single.component.dispose(); }
	}
});

test("simple-form bool Left/Right move the internal focus while Up/Down leave the field", () => {
	const { component } = mount({ questions: [{ title: "Form", kind: "simple-form", fields: [
		{ name: "ok", label: "OK", kind: "bool" },
		{ name: "note", label: "Note", kind: "input" },
	] }] });
	try {
		assert.deepEqual(focusRegions(component.render(80), BG.dark), ["[ ] True"]);
		component.handleInput(K.right);
		assert.deepEqual(focusRegions(component.render(80), BG.dark), ["[ ] False"]);
		component.handleInput(K.right); // boundary: leave the bool field for the input
		assert.deepEqual(focusRegions(component.render(80), BG.dark), []);
		component.handleInput(K.up); // Up returns to the bool field
		assert.deepEqual(focusRegions(component.render(80), BG.dark), ["[ ] False"]);
		component.handleInput(K.down); // Down leaves the bool field again
		assert.deepEqual(focusRegions(component.render(80), BG.dark), []);
		component.handleInput(K.up); // and Up returns once more
		assert.deepEqual(focusRegions(component.render(80), BG.dark), ["[ ] False"]);
	} finally { component.dispose(); }
});

test("every question kind and both bool foci stay within the width without leaking the focus background", () => {
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

	function assertFits(label: string, width: number, lines: string[]) {
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= width, `${label} @${width}: overflow ${JSON.stringify(strip(line))}`);
			assertNoStyleLeak(line, BG.dark);
		}
	}

	for (const width of [16, 20, 30, 40, 80, 120]) {
		const { component } = mount(raw);
		try {
			// Tab 1: bool, focus True then focus False, then a selected False.
			assertFits("bool focus True", width, component.render(width));
			component.handleInput(K.right);
			assertFits("bool focus False", width, component.render(width));
			component.handleInput(K.space);
			component.handleInput(K.space);
			assertFits("bool selected false", width, component.render(width));

			// Tab 2: single — focus both options.
			component.handleInput(K.tab);
			assert.match(strip(component.render(width).join("\n")), /2\/4\. Pick/, "must be on the single tab");
			assertFits("single option 1", width, component.render(width));
			component.handleInput(K.down);
			assertFits("single option 2", width, component.render(width));

			// Tab 3: multi — focus both options.
			component.handleInput(K.tab);
			assert.match(strip(component.render(width).join("\n")), /3\/4\. Scope/, "must be on the multi tab");
			assertFits("multi option 1", width, component.render(width));
			component.handleInput(K.down);
			assertFits("multi option 2", width, component.render(width));

			// Tab 4: simple-form — walk the bool, single, multi and action rows.
			component.handleInput(K.tab);
			assert.match(strip(component.render(width).join("\n")), /4\/4\. Form/, "must be on the form tab");
			for (let step = 0; step < 6; step += 1) {
				assertFits(`form step ${step}`, width, component.render(width));
				component.handleInput(K.down);
			}

			// Review tab.
			component.handleInput(K.tab);
			assert.match(strip(component.render(width).join("\n")), /Review/);
			assertFits("review", width, component.render(width));
		} finally { component.dispose(); }
	}
});

/**
 * Real Pi `Theme` palettes (hex), used to drive the component through the actual
 * `Theme` implementation rather than the marker/mock themes above. `Theme` is a
 * root export; these questions only request the tokens listed here, so a partial
 * foreground record cast is enough and keeps the test off the full schema.
 */
const REAL_PALETTES = {
	dark: {
		text: "#d7d9e0", muted: "#9aa0b0", dim: "#7f859a", accent: "#b18ae0", border: "#8f8fd8",
		success: "#7fd6a3", error: "#e08a7a", warning: "#d6d47f", thinkingXhigh: "#e08ab0",
		selectedBg: "#1e2740",
	},
	light: {
		text: "#3a3f4b", muted: "#5c6274", dim: "#6b7182", accent: "#6f42c1", border: "#4f5fa8",
		success: "#2f8f5b", error: "#b3452f", warning: "#9a8a1f", thinkingXhigh: "#b0306f",
		selectedBg: "#e4e7ef",
	},
} as const;

function realTheme(appearance: "light" | "dark"): Theme {
	const { selectedBg, ...foreground } = REAL_PALETTES[appearance];
	// Pi 0.87's public `Theme` constructor takes resolved hex/index colors and no
	// appearance option, so this exercises the real implementation with two
	// light/dark palettes rather than loading the built-in theme JSON.
	return new Theme(foreground as never, { selectedBg } as never, "truecolor");
}

test("a real Pi Theme drives the focus token, resets and semantic colors on light and dark", () => {
	for (const appearance of ["dark", "light"] as const) {
		const theme = realTheme(appearance);
		const bg = theme.getBgAnsi("selectedBg");
		const success = theme.getFgAnsi("success");
		const error = theme.getFgAnsi("error");
		const accent = theme.getFgAnsi("accent");
		assert.notEqual(bg, "\x1b[49m", `${appearance}: selectedBg must resolve to a real tint`);

		const bool = mount(boolQuestion({ default: true }), { theme });
		try {
			const selected = bool.component.render(80).find((line) => line.includes("True"))!;
			assert.ok(selected.includes(bg), `${appearance}: focused region carries the selectedBg tint`);
			assert.ok(selected.includes(success), `${appearance}: selected True keeps its success color`);
			assertNoStyleLeak(selected, bg);
			assert.equal((selected.match(/\x1b\[49m/g) ?? []).length, selected.split(bg).length - 1, `${appearance}: tint opened and reset exactly once`);

			bool.component.handleInput(K.right);
			const refocused = bool.component.render(80).find((line) => line.includes("True"))!;
			assert.deepEqual(focusRegions([refocused], bg), ["[ ] False"], `${appearance}: tint follows focus, not selection`);
			assert.ok(refocused.includes(success), `${appearance}: True stays selected while False is focused`);
			assertNoStyleLeak(refocused, bg);

			// Select False (toggle from the true default): error color survives the tint.
			bool.component.handleInput(K.space);
			const crossed = bool.component.render(80).find((line) => line.includes("False"))!;
			assert.ok(crossed.includes(error), `${appearance}: selected False keeps its error color`);
			assertNoStyleLeak(crossed, bg);
		} finally { bool.component.dispose(); }

		const single = mount(singleQuestion, { theme });
		try {
			const focused = single.component.render(80).find((line) => line.includes("Alpha"))!;
			assert.ok(focused.includes(bg), `${appearance}: single focus tint missing`);
			assert.ok(focused.includes(accent), `${appearance}: focused single option keeps its accent color`);
			assertNoStyleLeak(focused, bg);
			const unfocused = single.component.render(80).find((line) => line.includes("Beta"))!;
			assert.ok(!unfocused.includes(bg), `${appearance}: unfocused option must have no tint`);
		} finally { single.component.dispose(); }

		const multi = mount(multiQuestion, { theme });
		try {
			const focused = multi.component.render(80).find((line) => line.includes("Alpha"))!;
			assert.ok(focused.includes(bg), `${appearance}: multi focus tint missing`);
			assertNoStyleLeak(focused, bg);
		} finally { multi.component.dispose(); }
	}
});
