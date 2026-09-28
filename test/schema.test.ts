import assert from "node:assert/strict";
import { test } from "node:test";
import {
	AskUserValidationError,
	DEFAULT_TIMEOUT_PER_QUESTION_MS,
	MAX_OPTIONS,
	MAX_QUESTIONS,
	normalizeAskUserRequest,
} from "../src/schema.ts";

test("normalizes a basic request and generates ids", () => {
	const { request } = normalizeAskUserRequest({
		questions: [
			{ title: "Deploy where?", kind: "single", options: [{ label: "staging" }, { label: "prod" }] },
			{ title: "Notes", kind: "input" },
		],
	});
	assert.equal(request.questions.length, 2);
	assert.deepEqual(
		request.questions.map((question) => question.id),
		["q1", "q2"],
	);
	assert.equal(request.displayMode, "overlay");
	assert.equal(request.timeoutPerQuestionMs, DEFAULT_TIMEOUT_PER_QUESTION_MS);
	assert.equal(request.totalTimeoutMs, DEFAULT_TIMEOUT_PER_QUESTION_MS * 2);
	assert.equal(request.questions[0]!.options.length, 2);
	assert.equal(request.questions[1]!.options.length, 0);
});

test("the deadline is strictly base × questionCount; absolute overrides are ignored", () => {
	const { request } = normalizeAskUserRequest({
		questions: [{ title: "A" }, { title: "B" }, { title: "C" }],
		timeoutPerQuestionMs: 1000,
		// Deliberately ignored: the invariant total = base × count must hold.
		timeoutMs: 10,
	});
	assert.equal(request.timeoutPerQuestionMs, 1000);
	assert.equal(request.totalTimeoutMs, 3000);
});

test("infers kind from options and multiSelect flag", () => {
	const { request } = normalizeAskUserRequest({
		questions: [
			{ question: "Pick many", options: ["a", "b"], multiSelect: true },
			{ title: "Pick one", options: ["a", "b"] },
			{ title: "Say something" },
		],
	});
	assert.equal(request.questions[0]!.kind, "multi");
	assert.equal(request.questions[1]!.kind, "single");
	assert.equal(request.questions[2]!.kind, "input");
});

test("accepts string questions and option aliases", () => {
	const { request } = normalizeAskUserRequest({
		questions: ["What next?", { title: "Which", options: [{ title: "X", desc: "ex" }] }],
	});
	assert.equal(request.questions[0]!.kind, "input");
	assert.equal(request.questions[1]!.options[0]!.label, "X");
	assert.equal(request.questions[1]!.options[0]!.description, "ex");
});

test("rejects more than 5 questions", () => {
	assert.throws(
		() => normalizeAskUserRequest({ questions: Array.from({ length: 6 }, (_, index) => ({ title: `Q${index}` })) }),
		(error) => error instanceof AskUserValidationError && /最多 5 个问题/.test(error.message),
	);
});

test("rejects more than 5 options per question", () => {
	assert.throws(
		() =>
			normalizeAskUserRequest({
				questions: [{ title: "Q", options: Array.from({ length: MAX_OPTIONS + 1 }, (_, index) => `o${index}`) }],
			}),
		(error) => error instanceof AskUserValidationError && /最多 5 个选项/.test(error.message),
	);
});

test("rejects empty question lists and missing titles", () => {
	assert.throws(() => normalizeAskUserRequest({ questions: [] }), AskUserValidationError);
	assert.throws(() => normalizeAskUserRequest({ questions: [{ options: ["a"] }] }), AskUserValidationError);
});

test("deduplicates option labels with a warning", () => {
	const { request, warnings } = normalizeAskUserRequest({
		questions: [{ title: "Q", options: ["a", "a", "b"] }],
	});
	assert.equal(request.questions[0]!.options.length, 2);
	assert.ok(warnings.some((warning) => /重复选项/.test(warning)));
});

test("a choice question with no usable options falls back to input", () => {
	const { request } = normalizeAskUserRequest({ questions: [{ title: "Q", kind: "single" }] });
	assert.equal(request.questions[0]!.kind, "input");
});

test("carries defaults and marks hasDefault", () => {
	const { request } = normalizeAskUserRequest({
		questions: [{ title: "Q", options: ["a", "b"], default: "b" }],
	});
	assert.equal(request.questions[0]!.hasDefault, true);
	assert.equal(request.questions[0]!.default, "b");
});

test("clamps over-long fields", () => {
	const { request } = normalizeAskUserRequest({
		questions: [{ title: "x".repeat(500), options: ["a"] }],
	});
	assert.ok(request.questions[0]!.title.length <= 200);
});

test("MAX_QUESTIONS constant matches the schema limit", () => {
	assert.equal(MAX_QUESTIONS, 5);
});
