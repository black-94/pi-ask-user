import assert from "node:assert/strict";
import { test } from "node:test";
import { formatPlainText } from "../src/plaintext.ts";
import { normalizeAskUserRequest } from "../src/schema.ts";
import type { NormalizedRequest } from "../src/types.ts";

function request(input: unknown): NormalizedRequest {
	return normalizeAskUserRequest(input).request;
}

test("every question block ends with a free-input line", () => {
	const text = formatPlainText(
		request({
			header: "部署决策",
			questions: [
				{ title: "部署目标", kind: "single", prompt: "选择目标环境", options: [{ label: "staging", description: "预发布" }, { label: "prod" }] },
				{ title: "测试范围", kind: "multi", options: [{ label: "unit" }, { label: "integration" }] },
				{ title: "备注", kind: "input" },
			],
		}),
	);
	const blocks = text.split(/\n(?=问题 \d+\/)/);
	assert.equal(blocks.length, 4); // intro + 3 questions
	for (const block of blocks.slice(1)) {
		const lines = block.trimEnd().split("\n");
		assert.match(lines[lines.length - 1]!, /自由输入/);
	}
});

test("includes titles, input hints, options, and no preview", () => {
	const text = formatPlainText(
		request({
			questions: [
				{
					title: "部署目标",
					kind: "single",
					options: [{ label: "staging", description: "预发布", preview: "SECRET PREVIEW" }],
				},
			],
		}),
	);
	assert.match(text, /问题 1\/1：部署目标/);
	assert.match(text, /输入提示：单选/);
	assert.match(text, /\[1\] staging — 预发布/);
	assert.doesNotMatch(text, /SECRET PREVIEW/);
});

test("multi hint mentions comma-separated numbers", () => {
	const text = formatPlainText(request({ questions: [{ title: "Q", kind: "multi", options: ["a", "b"] }] }));
	assert.match(text, /多选/);
	assert.match(text, /逗号/);
});

test("defaults are announced as skippable", () => {
	const text = formatPlainText(request({ questions: [{ title: "Q", options: ["a", "b"], default: "a" }] }));
	assert.match(text, /默认值：a/);
});
