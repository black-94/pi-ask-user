import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { createDeadline } from "../src/deadline.ts";
import { normalizeAskUserRequest } from "../src/schema.ts";
import { AskUserComponent, SPLIT_MIN_WIDTH, type AskUserTheme, type CustomUIResult } from "../src/ui/custom.ts";
import type { NormalizedRequest } from "../src/types.ts";

const theme: AskUserTheme = {
	fg: (_color, text) => text,
	bold: (text) => text,
	italic: (text) => text,
	underline: (text) => text,
	strikethrough: (text) => text,
	inverse: (text) => text,
};

const KEYS = {
	escape: "\x1b",
	tab: "\t",
	shiftTab: "\x1b[Z",
	enter: "\r",
	space: " ",
	down: "\x1b[B",
	up: "\x1b[A",
	pageDown: "\x1b[6~",
	pageUp: "\x1b[5~",
	ctrlEnter: "\x1b[13;5u",
	backspace: "\x7f",
};

function request(input: unknown): NormalizedRequest {
	return normalizeAskUserRequest(input).request;
}

function mount(req: NormalizedRequest, deadlineMs = 10_000, rows = 24) {
	let result: CustomUIResult | undefined;
	const renders: number[] = [];
	const component = new AskUserComponent({
		request: req,
		deadline: createDeadline(deadlineMs),
		theme,
		tui: {
			requestRender: () => {
				renders.push(1);
			},
			terminal: { rows, columns: 100 },
		},
		done: (value) => {
			result = value;
		},
	});
	return { component, getResult: () => result, renders };
}

function assertFits(lines: string[], width: number) {
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= width, `line exceeds width ${width}: ${JSON.stringify(line)}`);
	}
}

test("wide terminals render the option preview in a right column", () => {
	const req = request({
		questions: [
			{
				title: "Choose",
				kind: "single",
				options: [
					{ label: "Alpha", preview: "# Alpha preview" },
					{ label: "Beta" },
				],
			},
		],
	});
	const { component } = mount(req);
	const lines = component.render(120);
	assertFits(lines, 120);
	const text = lines.join("\n");
	assert.match(text, /Alpha preview/);
	// The preview shares a line with the option column on wide screens.
	assert.ok(lines.some((line) => /Alpha/.test(line) && /Alpha preview/.test(line)));
});

test("narrow terminals stack the preview below the options", () => {
	const width = SPLIT_MIN_WIDTH - 20;
	const req = request({
		questions: [
			{
				title: "Choose",
				kind: "single",
				options: [
					{ label: "Alpha", preview: "# Alpha preview" },
					{ label: "Beta" },
				],
			},
		],
	});
	const { component } = mount(req);
	const lines = component.render(width);
	assertFits(lines, width);
	const text = lines.join("\n");
	assert.match(text, /Alpha preview/);
	assert.ok(text.includes("Preview:"));
	assert.ok(!lines.some((line) => /1\. Alpha/.test(line) && /Alpha preview/.test(line)));
});

test("no preview is shown when the focused option has none", () => {
	const req = request({
		questions: [{ title: "Choose", kind: "single", options: [{ label: "Alpha" }, { label: "Beta", preview: "never" }] }],
	});
	const { component } = mount(req);
	const lines = component.render(120);
	assert.ok(!lines.join("\n").includes("never"));
});

test("single-select: Enter selects and submits", () => {
	const req = request({
		questions: [{ title: "Deploy", kind: "single", options: [{ label: "staging" }, { label: "prod" }] }],
	});
	const { component, getResult } = mount(req);
	component.handleInput(KEYS.down);
	component.handleInput(KEYS.enter);
	const result = getResult();
	assert.ok(result);
	assert.equal(result!.kind, "submitted");
	assert.deepEqual(result!.answers![0]!.selections, ["prod"]);
});

test("multi-select: selection and free text submit together", () => {
	const req = request({
		questions: [{ title: "Scope", kind: "multi", options: [{ label: "unit" }, { label: "integration" }] }],
	});
	const { component, getResult } = mount(req);
	component.handleInput(KEYS.space); // toggle unit
	component.handleInput(KEYS.down); // move onto integration
	component.handleInput(KEYS.space); // toggle integration
	component.handleInput(KEYS.down); // move to free input row
	component.handleInput("also docs");
	component.handleInput(KEYS.enter);
	const result = getResult();
	assert.ok(result);
	assert.equal(result!.kind, "submitted");
	assert.deepEqual(result!.answers![0]!.selections, ["unit", "integration"]);
	assert.equal(result!.answers![0]!.freeText, "also docs");
});

test("free input is always present and typing jumps to it", () => {
	const req = request({
		questions: [{ title: "Deploy", kind: "single", options: [{ label: "staging" }, { label: "prod" }] }],
	});
	const { component, getResult } = mount(req);
	component.handleInput("hello"); // typing on an option row focuses the input
	component.handleInput(KEYS.enter);
	const result = getResult();
	assert.ok(result);
	assert.equal(result!.kind, "submitted");
	assert.equal(result!.answers![0]!.freeText, "hello");
});

test("a required question blocks submission until answered", () => {
	const req = request({ questions: [{ title: "Notes", kind: "input" }] });
	const { component, getResult } = mount(req);
	component.handleInput(KEYS.enter);
	assert.equal(getResult(), undefined);
	assert.match(component.render(80).join("\n"), /required/i);
});

test("a question with a default can be skipped with `s`", () => {
	const req = request({
		questions: [{ title: "Deploy", kind: "single", options: [{ label: "staging" }, { label: "prod" }], default: "prod" }],
	});
	const { component, getResult } = mount(req);
	component.handleInput("s");
	const result = getResult();
	assert.ok(result);
	assert.equal(result!.kind, "submitted");
	assert.deepEqual(result!.answers![0]!.selections, ["prod"]);
	assert.equal(result!.answers![0]!.usedDefault, true);
});

test("multiple questions: tabs reach a review tab before submitting", () => {
	const req = request({
		questions: [
			{ title: "First", kind: "single", options: [{ label: "a" }, { label: "b" }] },
			{ title: "Second", kind: "single", options: [{ label: "c" }, { label: "d" }] },
		],
	});
	const { component, getResult } = mount(req);
	assert.match(component.render(100).join("\n"), /Submit/);
	component.handleInput(KEYS.enter); // answer first -> advances to second tab
	component.handleInput(KEYS.enter); // answer second -> advances to review tab
	assert.equal(getResult(), undefined);
	const review = component.render(100).join("\n");
	assert.match(review, /Review before submitting/);
	component.handleInput(KEYS.enter); // submit from review
	const result = getResult();
	assert.ok(result);
	assert.deepEqual(
		result!.answers!.map((answer) => answer.selections[0]),
		["a", "c"],
	);
});

test("review blocks submission while a question is unanswered", () => {
	const req = request({
		questions: [
			{ title: "First", kind: "single", options: [{ label: "a" }, { label: "b" }] },
			{ title: "Second", kind: "single", options: [{ label: "c" }, { label: "d" }] },
		],
	});
	const { component, getResult } = mount(req);
	component.handleInput(KEYS.shiftTab); // jump to the review tab without answering
	component.handleInput(KEYS.enter);
	assert.equal(getResult(), undefined);
	assert.match(component.render(100).join("\n"), /no answer yet/i);
});

test("Escape cancels", () => {
	const req = request({ questions: [{ title: "Notes", kind: "input" }] });
	const { component, getResult } = mount(req);
	component.handleInput(KEYS.escape);
	assert.equal(getResult()?.kind, "cancelled");
});

test("the component times out at the deadline", async () => {
	const req = request({ questions: [{ title: "Notes", kind: "input" }] });
	const { component, getResult } = mount(req, 15);
	await new Promise((resolve) => setTimeout(resolve, 45));
	assert.equal(getResult()?.kind, "timeout");
	component.dispose();
});

test("full-width and emoji labels stay within narrow widths", () => {
	const req = request({
		questions: [
			{
				title: "Ｄｅｐｌｏｙ ｔａｒｇｅｔ ｐｉｃｋｅｒ",
				kind: "multi",
				options: [
					{ label: "Ｐｒｅ－ｒｅｌｅａｓｅ （ｓｔａｇｉｎｇ）", description: "Ｆｏｒ ｉｎｔｅｒｎａｌ ｖｅｒｉｆｉｃａｔｉｏｎ 🚀" },
					{ label: "Ｐｒｏｄｕｃｔｉｏｎ", description: "Ｆｏｒ ｒｅａｌ ｕｓｅｒｓ" },
				],
			},
		],
	});
	const { component } = mount(req);
	for (const width of [30, 40, 60, 100]) {
		assertFits(component.render(width), width);
	}
});

test("abort() finishes with an abort result", () => {
	const req = request({ questions: [{ title: "Notes", kind: "input" }] });
	const { component, getResult } = mount(req);
	component.abort();
	assert.equal(getResult()?.kind, "abort");
});

test("a focused free-input row emits the IME cursor marker", () => {
	const req = request({ questions: [{ title: "Notes", kind: "input" }] });
	const { component } = mount(req);
	component.focused = true;
	const lines = component.render(80);
	assert.ok(lines.join("").includes(CURSOR_MARKER), "focused input must emit CURSOR_MARKER");
	// Losing focus re-renders without the marker.
	component.focused = false;
	assert.ok(!component.render(80).join("").includes(CURSOR_MARKER));
});

test("Up from the free-input row returns to the options", () => {
	const req = request({
		questions: [{ title: "Deploy", kind: "single", options: [{ label: "staging" }, { label: "prod" }] }],
	});
	const { component, getResult } = mount(req);
	component.handleInput(KEYS.down); // option index 1 (prod)
	component.handleInput(KEYS.down); // free-input row
	component.handleInput("a note"); // typed into the input
	component.handleInput(KEYS.up); // back to option index 1
	component.handleInput(KEYS.enter); // select the focused option and submit
	const result = getResult();
	assert.ok(result);
	assert.equal(result!.kind, "submitted");
	// Submitting a selection (not free text) proves Up was not swallowed by the input,
	// and the typed note is preserved alongside the selection.
	assert.deepEqual(result!.answers![0]!.selections, ["prod"]);
	assert.equal(result!.answers![0]!.freeText, "a note");
});

test("the typed note survives going back to the options and returning", () => {
	const req = request({
		questions: [{ title: "Deploy", kind: "single", options: [{ label: "staging" }, { label: "prod" }] }],
	});
	const { component, getResult } = mount(req);
	component.handleInput(KEYS.down); // input row
	component.handleInput("keep me");
	component.handleInput(KEYS.up); // options row
	component.handleInput(KEYS.down); // input row again
	component.handleInput(KEYS.enter); // commit + submit
	const result = getResult();
	assert.ok(result);
	assert.equal(result!.answers![0]!.freeText, "keep me");
});

test("option descriptions wrap to the option column instead of being truncated", () => {
	const longDescription = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda";
	const req = request({
		questions: [
			{
				title: "Choose",
				kind: "single",
				options: [
					{ label: "Alpha", description: longDescription, preview: "# p" },
					{ label: "Beta" },
				],
			},
		],
	});
	const { component } = mount(req);
	const lines = component.render(120);
	assertFits(lines, 120);
	assert.ok(lines.join("\n").includes("lambda"), "the end of the description must be visible");
});

test("a long preview can be paged into view", () => {
	const preview = Array.from({ length: 40 }, (_, index) => `LINE${index}`).join("\n\n");
	const req = request({
		questions: [{ title: "Choose", kind: "single", options: [{ label: "Alpha", preview }, { label: "Beta" }] }],
	});
	const { component } = mount(req);
	const first = component.render(120).join("\n");
	assert.match(first, /LINE0/);
	assert.ok(!first.includes("LINE39"), "the tail must be out of view initially");
	for (let index = 0; index < 20; index += 1) component.handleInput(KEYS.pageDown);
	const later = component.render(120).join("\n");
	assert.match(later, /LINE39/);
});

test("very small widths never overflow", () => {
	const req = request({
		questions: [
			{
				title: "Ｃｈｏｏｓｅ ａ ｄｅｐｌｏｙ ｔａｒｇｅｔ",
				kind: "multi",
				options: [
					{ label: "Ｐｒｅ－ｒｅｌｅａｓｅ", description: "Ｉｎｔｅｒｎａｌ ｖｅｒｉｆｉｃａｔｉｏｎ", preview: "# Ｐｒｅ－ｒｅｌｅａｓｅ" },
					{ label: "Ｐｒｏｄｕｃｔｉｏｎ", description: "Ｒｅａｌ ｕｓｅｒｓ" },
				],
			},
		],
	});
	const { component } = mount(req);
	for (const width of [1, 2, 5, 10, 19, 20, 21]) {
		assertFits(component.render(width), width);
	}
});

const FIVE_LONG = {
	questions: [
		{
			title: "Choose one",
			kind: "single",
			options: Array.from({ length: 5 }, (_, index) => ({
				label: `Option ${index + 1}`,
				description: `A long description for option ${index + 1} that wraps across several lines in the option column so the body grows past the viewport height.`,
				preview: `# Option ${index + 1}\n\n${Array.from({ length: 12 }, (_, line) => `- preview line ${line}`).join("\n")}`,
			})),
		},
	],
};

test("the free-input row stays visible with 5 long options at rows 12 and 24", () => {
	for (const rows of [12, 24]) {
		const { component } = mount(request(FIVE_LONG), 10_000, rows);
		// Focus stays on the first option; the body is taller than the viewport.
		const lines = component.render(100);
		assert.ok(lines.length <= rows, `height ${lines.length} exceeds rows ${rows}`);
		assert.match(lines.join("\n"), /›/, "the free-input row must be visible");
		component.dispose();
	}
});

test("the free-input row and a cancel hint survive rows 5 and 8", () => {
	for (const rows of [5, 8]) {
		const { component } = mount(request(FIVE_LONG), 10_000, rows);
		const lines = component.render(100);
		assert.ok(lines.length <= rows, `height ${lines.length} exceeds rows ${rows}`);
		const text = lines.join("\n");
		assert.match(text, /›/, "the free-input row must be visible");
		assert.match(text, /Esc cancel/, "a cancel hint must be visible");
		component.dispose();
	}
});

test("very short terminals degrade without overflowing", () => {
	const req = request(FIVE_LONG);
	// rows >= MIN_USABLE_ROWS keeps title + input + hint.
	for (const rows of [3, 4]) {
		const { component } = mount(req, 10_000, rows);
		const text = component.render(100).join("\n");
		assert.equal(component.render(100).length, rows);
		assert.match(text, /›/);
		assert.match(text, /Esc cancel/);
		component.dispose();
	}
	// Below the minimum the input is still kept; the hint is dropped at rows 1-2.
	for (const rows of [1, 2]) {
		const { component } = mount(req, 10_000, rows);
		const lines = component.render(100);
		assert.equal(lines.length, rows, `rows ${rows} must render exactly ${rows} lines`);
		assert.match(lines.join("\n"), /›/, "the input must still be present");
		component.dispose();
	}
	// Zero rows renders nothing rather than overflowing.
	const { component } = mount(req, 10_000, 0);
	assert.deepEqual(component.render(100), []);
	component.dispose();
});

test("the pinned input row is reachable and submittable at rows 8", () => {
	const { component, getResult } = mount(
		request({ questions: [{ title: "Deploy", kind: "single", options: [{ label: "staging" }, { label: "prod" }] }] }),
		10_000,
		8,
	);
	component.handleInput("a note"); // typing jumps to the pinned input
	component.handleInput(KEYS.enter);
	const result = getResult();
	assert.ok(result);
	assert.equal(result!.answers![0]!.freeText, "a note");
});

test("(a) single-select: text typed first survives selecting an option and submitting", () => {
	const req = request({
		questions: [{ title: "Deploy", kind: "single", options: [{ label: "staging" }, { label: "prod" }] }],
	});
	const { component, getResult } = mount(req);
	component.handleInput("note from input"); // jumps to the input row
	component.handleInput(KEYS.up); // back to the options
	component.handleInput(KEYS.up); // onto the first option
	component.handleInput(KEYS.enter); // select + submit
	const result = getResult();
	assert.ok(result);
	assert.equal(result!.kind, "submitted");
	assert.deepEqual(result!.answers![0]!.selections, ["staging"]);
	assert.equal(result!.answers![0]!.freeText, "note from input");
});

test("(b) multi-select: options and text both submit via Ctrl+Enter", () => {
	const req = request({
		questions: [{ title: "Scope", kind: "multi", options: [{ label: "unit" }, { label: "integration" }] }],
	});
	const { component, getResult } = mount(req);
	component.handleInput(KEYS.space); // toggle unit
	component.handleInput(KEYS.down); // onto integration
	component.handleInput(KEYS.space); // toggle integration
	component.handleInput("plus docs"); // printable -> jumps to the input and types
	component.handleInput(KEYS.ctrlEnter); // submit directly
	const result = getResult();
	assert.ok(result);
	assert.equal(result!.kind, "submitted");
	assert.deepEqual(result!.answers![0]!.selections, ["unit", "integration"]);
	assert.equal(result!.answers![0]!.freeText, "plus docs");
});

test("(c) switching tabs then submitting from the review tab keeps each answer", () => {
	const req = request({
		questions: [
			{ title: "First", kind: "single", options: [{ label: "a" }, { label: "b" }] },
			{ title: "Second", kind: "single", options: [{ label: "c" }, { label: "d" }] },
		],
	});
	const { component, getResult } = mount(req);
	component.handleInput("free text on q1"); // input row on q1
	component.handleInput(KEYS.tab); // switch to q2 (must not lose q1 text)
	component.handleInput(KEYS.enter); // select 'c' -> advances to the review tab
	const review = component.render(100).join("\n");
	assert.match(review, /free text on q1/, "the review tab must show the preserved draft");
	component.handleInput(KEYS.enter); // submit from review
	const result = getResult();
	assert.ok(result);
	assert.equal(result!.kind, "submitted");
	assert.deepEqual(result!.answers![0]!.selections, []);
	assert.equal(result!.answers![0]!.freeText, "free text on q1");
	assert.deepEqual(result!.answers![1]!.selections, ["c"]);
});

test("(d) clearing the input cannot bypass a required question", () => {
	const req = request({ questions: [{ title: "Notes", kind: "input" }] });
	const { component, getResult } = mount(req);
	component.handleInput("ab");
	component.handleInput(KEYS.backspace);
	component.handleInput(KEYS.backspace);
	component.handleInput(KEYS.ctrlEnter);
	assert.equal(getResult(), undefined, "an emptied required answer must not submit");
	assert.match(component.render(100).join("\n"), /no answer yet/i);
});

test("(d) clearing an optional input falls back to its default", () => {
	const req = request({ questions: [{ title: "Notes", kind: "input", default: "none" }] });
	const { component, getResult } = mount(req);
	component.handleInput("typed then cleared");
	for (let index = 0; index < 20; index += 1) component.handleInput(KEYS.backspace);
	component.handleInput(KEYS.ctrlEnter);
	const result = getResult();
	assert.ok(result);
	assert.equal(result!.answers![0]!.freeText, "none");
	assert.equal(result!.answers![0]!.usedDefault, true);
});

test("editing an input that came from the default clears usedDefault", () => {
	const req = request({
		questions: [
			{ title: "Deploy", kind: "single", options: [{ label: "staging" }, { label: "prod" }], default: "prod" },
			{ title: "Scope", kind: "single", options: [{ label: "unit" }, { label: "e2e" }], default: "e2e" },
		],
	});
	const { component, getResult } = mount(req);
	component.handleInput("s"); // apply q1 default -> advance to q2
	component.handleInput(KEYS.shiftTab); // back to q1
	component.handleInput("x"); // edit the input
	component.handleInput(KEYS.ctrlEnter); // submit
	const result = getResult();
	assert.ok(result);
	assert.deepEqual(result!.answers![0]!.selections, ["prod"]);
	assert.equal(result!.answers![0]!.freeText, "x");
	assert.equal(result!.answers![0]!.usedDefault, false, "an edited answer is no longer the default");
});

test("ANSI-styled themes still measure width correctly", () => {
	const ansiTheme: AskUserTheme = {
		fg: (_color, text) => `\x1b[36m${text}\x1b[0m`,
		bold: (text) => `\x1b[1m${text}\x1b[0m`,
		inverse: (text) => `\x1b[7m${text}\x1b[0m`,
	};
	const req = request({
		questions: [
			{
				title: "Ｃｈｏｏｓｅ ａ ｄｅｐｌｏｙ ｔａｒｇｅｔ",
				kind: "single",
				options: [
					{ label: "Ｐｒｅ－ｒｅｌｅａｓｅ", description: "Ｉｎｔｅｒｎａｌ ｖｅｒｉｆｉｃａｔｉｏｎ", preview: "# Ｐｒｅ－ｒｅｌｅａｓｅ\n\n- Ｆａｓｔ" },
					{ label: "Ｐｒｏｄｕｃｔｉｏｎ", description: "Ｒｅａｌ ｕｓｅｒｓ" },
				],
			},
		],
	});
	const component = new AskUserComponent({
		request: req,
		deadline: createDeadline(10_000),
		theme: ansiTheme,
		tui: { requestRender: () => {}, terminal: { rows: 24, columns: 120 } },
		done: () => {},
	});
	for (const width of [40, 90, 120]) {
		const lines = component.render(width);
		assertFits(lines, width);
	}
	assert.ok(component.render(120).join("\n").includes("\x1b["));
});
