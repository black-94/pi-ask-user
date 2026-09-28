import assert from "node:assert/strict";
import { test } from "node:test";
import { nativeInputHint, parseNativeAnswer } from "../src/parse.ts";
import type { NormalizedQuestion } from "../src/types.ts";

function question(kind: NormalizedQuestion["kind"], labels: string[]): NormalizedQuestion {
	return {
		id: "q1",
		index: 0,
		title: "Q",
		kind,
		options: labels.map((label) => ({ label })),
		hasDefault: false,
	};
}

const single = question("single", ["A", "B", "C"]);
const multi = question("multi", ["A", "B", "C"]);
const input = question("input", []);

test("single: bare number", () => {
	const outcome = parseNativeAnswer(single, "2");
	assert.ok(outcome.ok);
	assert.deepEqual(outcome.value, { selections: [1], empty: false });
});

test("single: number with trailing note", () => {
	const outcome = parseNativeAnswer(single, "2 | keep the API");
	assert.ok(outcome.ok);
	assert.deepEqual(outcome.value, { selections: [1], freeText: "keep the API", empty: false });
});

test("single: free text without a number", () => {
	const outcome = parseNativeAnswer(single, "neither, do something else");
	assert.ok(outcome.ok);
	assert.deepEqual(outcome.value, { selections: [], freeText: "neither, do something else", empty: false });
});

test("single: free text keeps a pipe when there is no number", () => {
	const outcome = parseNativeAnswer(single, "use a | b");
	assert.ok(outcome.ok);
	assert.deepEqual(outcome.value, { selections: [], freeText: "use a | b", empty: false });
});

test("single: pipe with no number is treated as free input", () => {
	const outcome = parseNativeAnswer(single, "| just the note");
	assert.ok(outcome.ok);
	assert.deepEqual(outcome.value, { selections: [], freeText: "just the note", empty: false });
});

test("single: multiple numbers are rejected", () => {
	const outcome = parseNativeAnswer(single, "1,2");
	assert.equal(outcome.ok, false);
	if (!outcome.ok) assert.match(outcome.error, /单选/);
});

test("single: out-of-range number is rejected", () => {
	const outcome = parseNativeAnswer(single, "9");
	assert.equal(outcome.ok, false);
	if (!outcome.ok) assert.match(outcome.error, /越界/);
});

test("single: zero is rejected as out of range", () => {
	const outcome = parseNativeAnswer(single, "0");
	assert.equal(outcome.ok, false);
});

test("single: malformed number-like input is rejected", () => {
	const outcome = parseNativeAnswer(single, "1.5");
	assert.equal(outcome.ok, false);
	if (!outcome.ok) assert.match(outcome.error, /编号无效/);
});

test("single: `1,a` is a malformed number list, not free text", () => {
	const outcome = parseNativeAnswer(single, "1,a");
	assert.equal(outcome.ok, false);
	if (!outcome.ok) assert.match(outcome.error, /编号无效/);
});

test("single: `2, please` is a malformed number list", () => {
	const outcome = parseNativeAnswer(single, "2, please");
	assert.equal(outcome.ok, false);
});

test("single: prose starting with a digit and a space is free text", () => {
	const outcome = parseNativeAnswer(single, "2 options please");
	assert.ok(outcome.ok);
	assert.deepEqual(outcome.value, { selections: [], freeText: "2 options please", empty: false });
});

test("single: prose with a leading sentence is free text", () => {
	const outcome = parseNativeAnswer(single, "3 months is fine");
	assert.ok(outcome.ok);
	assert.equal(outcome.value.freeText, "3 months is fine");
});

test("single: an empty left side with a pipe is free input", () => {
	const outcome = parseNativeAnswer(single, "| 1, please explain");
	assert.ok(outcome.ok);
	assert.deepEqual(outcome.value, { selections: [], freeText: "1, please explain", empty: false });
});

test("multi: comma list", () => {
	const outcome = parseNativeAnswer(multi, "1,3");
	assert.ok(outcome.ok);
	assert.deepEqual(outcome.value.selections, [0, 2]);
});

test("multi: spaces and CJK separators", () => {
	assert.deepEqual(parseNativeAnswer(multi, "1 3").ok && (parseNativeAnswer(multi, "1 3") as any).value.selections, [0, 2]);
	assert.deepEqual(parseNativeAnswer(multi, "1，3").ok && (parseNativeAnswer(multi, "1，3") as any).value.selections, [0, 2]);
	assert.deepEqual(parseNativeAnswer(multi, "1、3").ok && (parseNativeAnswer(multi, "1、3") as any).value.selections, [0, 2]);
});

test("multi: deduplicates repeated numbers", () => {
	const outcome = parseNativeAnswer(multi, "2,2,1");
	assert.ok(outcome.ok);
	assert.deepEqual(outcome.value.selections, [0, 1]);
});

test("multi: list with note", () => {
	const outcome = parseNativeAnswer(multi, "1,3 | some note");
	assert.ok(outcome.ok);
	assert.deepEqual(outcome.value.selections, [0, 2]);
	assert.equal(outcome.value.freeText, "some note");
});

test("multi: out-of-range member is rejected", () => {
	const outcome = parseNativeAnswer(multi, "1,9");
	assert.equal(outcome.ok, false);
});

test("input kind: numbers are literal text", () => {
	const outcome = parseNativeAnswer(input, "42");
	assert.ok(outcome.ok);
	assert.deepEqual(outcome.value, { selections: [], freeText: "42", empty: false });
});

test("empty input is reported as empty", () => {
	const outcome = parseNativeAnswer(single, "   ");
	assert.ok(outcome.ok);
	assert.equal(outcome.value.empty, true);
});

test("input hint depends on question kind", () => {
	assert.match(nativeInputHint(single), /编号/);
	assert.match(nativeInputHint(multi), /逗号/);
	assert.match(nativeInputHint(input), /文本/);
});
