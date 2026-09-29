import assert from "node:assert/strict";
import { test } from "node:test";
import {
	AskUserValidationError,
	DEFAULT_TIMEOUT_PER_QUESTION_MS,
	MAX_OPTIONS,
	MAX_QUESTIONS,
	normalizeAskUserRequest,
} from "../src/schema.ts";

test("normalizes a canonical request and generates ids", () => {
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

test("carries header, prompt, kind and option description/preview", () => {
	const { request } = normalizeAskUserRequest({
		header: "Release",
		displayMode: "inline",
		questions: [
			{
				title: "Which",
				prompt: "Pick one",
				kind: "single",
				options: [{ label: "X", description: "ex", preview: "# X" }],
			},
		],
	});
	assert.equal(request.header, "Release");
	assert.equal(request.displayMode, "inline");
	assert.equal(request.questions[0]!.prompt, "Pick one");
	assert.equal(request.questions[0]!.options[0]!.label, "X");
	assert.equal(request.questions[0]!.options[0]!.description, "ex");
	assert.equal(request.questions[0]!.options[0]!.preview, "# X");
});

test("the deadline is strictly base × questionCount and rejects an absolute override", () => {
	const { request } = normalizeAskUserRequest({
		questions: [{ title: "A" }, { title: "B" }, { title: "C" }],
		timeoutPerQuestionMs: 1000,
	});
	assert.equal(request.timeoutPerQuestionMs, 1000);
	assert.equal(request.totalTimeoutMs, 3000);
	// There is no absolute override: the extra key is rejected, not honoured.
	assert.throws(
		() => normalizeAskUserRequest({ questions: [{ title: "A" }], timeoutMs: 10 }),
		AskUserValidationError,
	);
});

test("infers kind from options; multi is explicit", () => {
	const { request } = normalizeAskUserRequest({
		questions: [
			{ title: "Pick many", kind: "multi", options: [{ label: "a" }, { label: "b" }] },
			{ title: "Pick one", options: [{ label: "a" }, { label: "b" }] },
			{ title: "Say something" },
		],
	});
	assert.equal(request.questions[0]!.kind, "multi");
	assert.equal(request.questions[1]!.kind, "single");
	assert.equal(request.questions[2]!.kind, "input");
});

test("rejects more than 5 questions", () => {
	assert.throws(
		() => normalizeAskUserRequest({ questions: Array.from({ length: 6 }, (_, index) => ({ title: `Q${index}` })) }),
		(error) => error instanceof AskUserValidationError && /at most 5 questions/i.test(error.message),
	);
});

test("rejects more than 5 options per question", () => {
	assert.throws(
		() =>
			normalizeAskUserRequest({
				questions: [
					{
						title: "Q",
						kind: "single",
						options: Array.from({ length: MAX_OPTIONS + 1 }, (_, index) => ({ label: `o${index}` })),
					},
				],
			}),
		(error) => error instanceof AskUserValidationError && /more than 5 options/i.test(error.message),
	);
});

test("rejects empty question lists, missing titles and non-object questions", () => {
	assert.throws(() => normalizeAskUserRequest({ questions: [] }), AskUserValidationError);
	assert.throws(
		() => normalizeAskUserRequest({ questions: [{ options: [{ label: "a" }] }] }),
		AskUserValidationError,
	);
	assert.throws(() => normalizeAskUserRequest({ questions: ["What next?"] }), AskUserValidationError);
});

test("rejects a choice question with no options instead of converting it", () => {
	assert.throws(
		() => normalizeAskUserRequest({ questions: [{ title: "Q", kind: "single" }] }),
		(error) => error instanceof AskUserValidationError && /no options/i.test(error.message),
	);
	assert.throws(() => normalizeAskUserRequest({ questions: [{ title: "Q", kind: "multi" }] }), AskUserValidationError);
});

test("rejects an unknown kind, a non-object option and a bad displayMode", () => {
	assert.throws(
		() => normalizeAskUserRequest({ questions: [{ title: "Q", kind: "choice" }] }),
		AskUserValidationError,
	);
	assert.throws(
		() => normalizeAskUserRequest({ questions: [{ title: "Q", options: ["a"] }] }),
		AskUserValidationError,
	);
	assert.throws(
		() => normalizeAskUserRequest({ questions: [{ title: "Q" }], displayMode: "modal" }),
		AskUserValidationError,
	);
});

test("rejects unknown fields", () => {
	const cases: unknown[] = [
		{ items: [{ title: "Q" }] },
		{ question: "Q" },
		{ questions: [{ title: "Q", choices: [{ label: "a" }] }] },
		{ questions: [{ title: "Q", type: "text" }] },
		{ questions: [{ title: "Q", options: [{ label: "a" }], multiSelect: true }] },
		{ questions: [{ title: "Q", options: [{ label: "a" }], defaultValue: "a" }] },
		{ questions: [{ title: "Q", options: [{ label: "a", desc: "x" }] }] },
		{ questions: [{ title: "Q", options: [{ label: "a" }] }], timeout_per_question_ms: 10 },
		{ questions: [{ title: "Q", options: [{ label: "a" }] }], display_mode: "inline" },
		{ questions: [{ title: "Q", options: [{ label: "a" }] }], extra: true },
	];
	for (const input of cases) {
		assert.throws(() => normalizeAskUserRequest(input), AskUserValidationError, JSON.stringify(input));
	}
});

test("rejects wrong shapes", () => {
	const cases: unknown[] = [
		{ questions: "Q" },
		{ questions: [{}] },
		{ questions: [{ title: "Q", options: "a" }] },
		{ questions: [{ title: "Q", kind: 1 }] },
		{ questions: [{ title: "Q", options: [{}] }] },
	];
	for (const input of cases) {
		assert.throws(() => normalizeAskUserRequest(input), AskUserValidationError, JSON.stringify(input));
	}
});

test("rejects an empty id and generates one only when the id is omitted", () => {
	assert.throws(
		() => normalizeAskUserRequest({ questions: [{ title: "Q", id: "   " }] }),
		(error) => error instanceof AskUserValidationError && /"id" must not be empty/.test(error.message),
	);
	const { request } = normalizeAskUserRequest({ questions: [{ title: "Q" }, { title: "R", id: "custom" }] });
	assert.equal(request.questions[0]!.id, "q1");
	assert.equal(request.questions[1]!.id, "custom");
});

test("rejects non-string fields and over-long fields", () => {
	assert.throws(() => normalizeAskUserRequest({ questions: [{ title: 42 }] }), AskUserValidationError);
	assert.throws(
		() => normalizeAskUserRequest({ questions: [{ title: "Q", default: 1 }] }),
		AskUserValidationError,
	);
	assert.throws(
		() => normalizeAskUserRequest({ questions: [{ title: "x".repeat(500), options: [{ label: "a" }] }] }),
		(error) => error instanceof AskUserValidationError && /200-character limit/.test(error.message),
	);
	assert.throws(
		() =>
			normalizeAskUserRequest({
				questions: [{ title: "Q", options: [{ label: "a" }] }],
				timeoutPerQuestionMs: -1,
			}),
		AskUserValidationError,
	);
});

test("deduplicates option labels with a warning", () => {
	const { request, warnings } = normalizeAskUserRequest({
		questions: [{ title: "Q", options: [{ label: "a" }, { label: "a" }, { label: "b" }] }],
	});
	assert.equal(request.questions[0]!.options.length, 2);
	assert.ok(warnings.some((warning) => /duplicate option/i.test(warning)));
});

test("carries defaults and marks hasDefault", () => {
	const { request } = normalizeAskUserRequest({
		questions: [{ title: "Q", options: [{ label: "a" }, { label: "b" }], default: "b" }],
	});
	assert.equal(request.questions[0]!.hasDefault, true);
	assert.equal(request.questions[0]!.default, "b");
});

test("rejects extra unknown fields at the top level", () => {
	for (const key of ["extra", "uiMode", "title"] as const) {
		assert.throws(
			() => normalizeAskUserRequest({ questions: [{ title: "Q", options: [{ label: "a" }] }], [key]: "x" }),
			AskUserValidationError,
			key,
		);
	}
});

test("MAX_QUESTIONS constant matches the schema limit", () => {
	assert.equal(MAX_QUESTIONS, 5);
});
