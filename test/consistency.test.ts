import assert from "node:assert/strict";
import { test } from "node:test";
import { createDeadline } from "../src/deadline.ts";
import { normalizeAskUserRequest } from "../src/schema.ts";
import { AskUserComponent, type CustomUIResult } from "../src/ui/custom.ts";
import { createNativeRunner } from "../src/ui/native.ts";
import type { AskUserAnswer, NormalizedRequest } from "../src/types.ts";

const identityTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	inverse: (text: string) => text,
};

function request(input: unknown): NormalizedRequest {
	return normalizeAskUserRequest(input).request;
}

const PARAMS = {
	questions: [
		{ title: "Deploy", kind: "single", options: [{ label: "staging" }, { label: "prod" }], default: "prod" },
		{ title: "Scope", kind: "multi", options: [{ label: "unit" }, { label: "integration" }], default: "integration" },
	],
};

async function viaCustom(): Promise<AskUserAnswer[]> {
	const req = request(PARAMS);
	let result: CustomUIResult | undefined;
	const component = new AskUserComponent({
		request: req,
		deadline: createDeadline(10_000),
		theme: identityTheme,
		tui: { requestRender: () => {}, terminal: { rows: 24, columns: 100 } },
		done: (value) => {
			result = value;
		},
	});
	component.handleInput("s"); // first question default -> advances
	component.handleInput("s"); // second question default -> advances to review
	component.handleInput("\r"); // submit from review
	component.dispose();
	assert.ok(result);
	return result!.answers!;
}

async function viaNative(): Promise<AskUserAnswer[]> {
	const req = request(PARAMS);
	const outcome = await createNativeRunner({ input: async () => "" }).run({
		request: req,
		deadline: createDeadline(10_000),
	});
	assert.equal(outcome.kind, "submitted");
	return outcome.answers!;
}

test("defaults resolve identically across the custom and native routes", async () => {
	const custom = await viaCustom();
	const native = await viaNative();
	assert.deepEqual(custom, native);
	assert.deepEqual(custom[0]!.selections, ["prod"]);
	assert.deepEqual(custom[1]!.selections, ["integration"]);
	for (const answer of custom) {
		assert.equal(answer.usedDefault, true);
	}
});

test("a free-text default (input question) is treated consistently", async () => {
	const params = { questions: [{ title: "Note", kind: "input", default: "none" }] };
	const viaComponent = () => {
		let result: CustomUIResult | undefined;
		const component = new AskUserComponent({
			request: request(params),
			deadline: createDeadline(10_000),
			theme: identityTheme,
			tui: { requestRender: () => {}, terminal: { rows: 24, columns: 100 } },
			done: (value) => {
				result = value;
			},
		});
		// For an input-kind question the box is the answer: Enter with an empty box
		// uses the default (the `s` key lives on the options list).
		component.handleInput("\r");
		component.dispose();
		return result!.answers!;
	};
	const native = await createNativeRunner({ input: async () => "" }).run({
		request: request(params),
		deadline: createDeadline(10_000),
	});
	assert.deepEqual(viaComponent(), native.answers);
	assert.equal(viaComponent()[0]!.freeText, "none");
	assert.equal(viaComponent()[0]!.usedDefault, true);
});
