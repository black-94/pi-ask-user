import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import { askUser } from "../src/core.ts";
import { createDeadline, MAX_SAFE_TIMEOUT_MS } from "../src/deadline.ts";
import { AppendixRegistry, createPlainTextHook, flushAppendix } from "../src/output.ts";
import type { AskUIInput, AskUserHost, NormalizedRequest } from "../src/types.ts";

const BASIC = {
	questions: [
		{ title: "Deploy where?", kind: "single", options: [{ label: "staging" }, { label: "prod" }] },
	],
};

function answeredHost(): AskUserHost {
	return {
		name: "custom",
		customUI: {
			render: async () => ({
				kind: "submitted",
				answers: [
					{
						index: 0,
						id: "q1",
						title: "Deploy where?",
						kind: "single",
						selections: ["prod"],
						usedDefault: false,
					},
				],
			}),
		},
		nativeDialogs: {
			run: async () => {
				throw new Error("native runner must not be used when customUI is declared");
			},
		},
	};
}

test("custom route wins and native is not called", async () => {
	const result = await askUser(BASIC, { host: answeredHost() });
	assert.equal(result.status, "answered");
	assert.equal(result.route, "custom");
	assert.deepEqual(result.answers[0]!.selections, ["prod"]);
});

test("native route is used when only nativeDialogs is declared", async () => {
	const result = await askUser(BASIC, {
		host: {
			name: "native",
			nativeDialogs: {
				run: async () => ({
					kind: "submitted",
					answers: [
						{ index: 0, id: "q1", title: "Deploy where?", kind: "single", selections: ["staging"], usedDefault: false },
					],
				}),
			},
		},
	});
	assert.equal(result.status, "answered");
	assert.equal(result.route, "native");
});

test("no declared UI takes the plain-text route and defers to the output hook", async () => {
	const registry = new AppendixRegistry();
		const host: AskUserHost = { name: "plain", plainText: createPlainTextHook(registry) };
	const result = await askUser(BASIC, { host });
	assert.equal(result.route, "plain_text");
	assert.equal(result.status, "deferred");
	assert.equal(result.deferred, true);
	assert.ok(result.plainText && result.plainText.includes("自由输入"));
	assert.equal(registry.hasPending(), true);

	const assistant = { role: "assistant", content: [{ type: "text", text: "Done." }] };
	const flushed = flushAppendix(assistant, registry);
	assert.ok(flushed);
	assert.equal(flushed.content.length, 2);
	assert.ok(flushed.content[1]!.text!.includes("自由输入"));
	assert.equal(registry.hasPending(), false);
});

test("plain text with no output hook is delivered inline as a normal fallback, not an error", async () => {
	const result = await askUser(BASIC, { host: { name: "nohook" } });
	assert.equal(result.route, "plain_text");
	assert.equal(result.status, "delivered");
	assert.equal(result.deferred, false);
	assert.equal(result.error, undefined, "a missing hook is a normal fallback, not an error");
	assert.ok(result.plainText && result.plainText.includes("自由输入"));
});

test("a declared output hook that throws is a genuine error, not a fallback", async () => {
	const host: AskUserHost = {
		name: "broken",
		plainText: {
			available: true,
			queue: () => {
				throw new Error("hook exploded");
			},
		},
	};
	const result = await askUser(BASIC, { host });
	assert.equal(result.status, "error");
	assert.equal(result.error?.code, "no_output_hook");
	assert.equal(result.deferred, false);
});

test("cancel, timeout, and error are distinguished and never degrade", async () => {
	let nativeCalled = false;
	const base: AskUserHost = {
		name: "custom",
		customUI: { render: async () => ({ kind: "cancelled" }) },
		nativeDialogs: {
			run: async () => {
				nativeCalled = true;
				return { kind: "cancelled" };
			},
		},
	};
	const cancelled = await askUser(BASIC, { host: base });
	assert.equal(cancelled.status, "cancelled");
	assert.equal(cancelled.cancelledReason, "user");
	assert.equal(nativeCalled, false);

	const timeout = await askUser(BASIC, {
		host: { name: "custom", customUI: { render: async () => ({ kind: "timeout" }) } },
	});
	assert.equal(timeout.status, "timeout");

	const errored = await askUser(BASIC, {
		host: {
			name: "custom",
			customUI: {
				render: async () => {
					throw new Error("boom");
				},
			},
			nativeDialogs: {
				run: async () => {
					nativeCalled = true;
					return { kind: "cancelled" };
				},
			},
		},
	});
	assert.equal(errored.status, "error");
	assert.equal(errored.error?.code, "custom_ui_failed");
	assert.equal(nativeCalled, false);
});

test("the shared deadline aborts and yields a timeout, not a fallback", async () => {
	let observedTotal = 0;
	const host: AskUserHost = {
		name: "custom",
		customUI: {
			render: (input: AskUIInput) =>
				new Promise((resolve) => {
					observedTotal = input.deadline.expiresAt - input.deadline.startedAt;
					const abort = () => resolve({ kind: "abort" as const });
					if (input.signal?.aborted) abort();
					else input.signal?.addEventListener("abort", abort, { once: true });
				}),
		},
		nativeDialogs: {
			run: async () => {
				throw new Error("must not fall back");
			},
		},
	};
	const result = await askUser(
		{ questions: [{ title: "A" }, { title: "B" }, { title: "C" }], timeoutPerQuestionMs: 20 },
		{ host },
	);
	assert.equal(result.status, "timeout");
	assert.equal(result.route, "custom");
	assert.equal(observedTotal, 60);
});

test("a caller abort is reported as cancelled/abort", async () => {
	const controller = new AbortController();
	const host: AskUserHost = {
		name: "custom",
		customUI: {
			render: (input) =>
				new Promise((resolve) => {
					const abort = () => resolve({ kind: "abort" as const });
					if (input.signal?.aborted) abort();
					else input.signal?.addEventListener("abort", abort, { once: true });
				}),
		},
	};
	const promise = askUser(BASIC, { host, signal: controller.signal });
	controller.abort();
	const result = await promise;
	assert.equal(result.status, "cancelled");
	assert.equal(result.cancelledReason, "abort");
});

test("a renderer that never resolves still yields a timeout (core owns the guarantee)", async () => {
	let nativeCalled = false;
	const host: AskUserHost = {
		name: "custom",
		// Ignores its AbortSignal entirely.
		customUI: { render: () => new Promise<never>(() => {}) },
		nativeDialogs: {
			run: async () => {
				nativeCalled = true;
				return { kind: "cancelled" };
			},
		},
	};
	const started = Date.now();
	const result = await askUser(
		{ questions: [{ title: "A" }, { title: "B" }], timeoutPerQuestionMs: 40 },
		{ host },
	);
	assert.equal(result.status, "timeout");
	assert.equal(result.route, "custom");
	assert.equal(result.deferred, false);
	assert.equal(nativeCalled, false);
	assert.ok(Date.now() - started < 2000, "must not hang");
});

test("a caller abort returns promptly even when the renderer ignores signals", async () => {
	const host: AskUserHost = {
		name: "custom",
		customUI: { render: () => new Promise<never>(() => {}) },
	};
	const controller = new AbortController();
	const promise = askUser(
		{ questions: [{ title: "A" }], timeoutPerQuestionMs: 100_000 },
		{ host, signal: controller.signal },
	);
	setTimeout(() => controller.abort(), 10);
	const result = await promise;
	assert.equal(result.status, "cancelled");
	assert.equal(result.cancelledReason, "abort");
});

test("a native runner that never resolves also times out without degrading", async () => {
	const result = await askUser(
		{ questions: [{ title: "A" }], timeoutPerQuestionMs: 40 },
		{ host: { name: "native", nativeDialogs: { run: () => new Promise<never>(() => {}) } } },
	);
	assert.equal(result.status, "timeout");
	assert.equal(result.route, "native");
});

test("an already-aborted call never queues a plain-text questionnaire", async () => {
	const registry = new AppendixRegistry();
	const host: AskUserHost = { name: "plain", plainText: createPlainTextHook(registry) };
	const controller = new AbortController();
	controller.abort();
	const result = await askUser(BASIC, { host, signal: controller.signal });
	assert.equal(result.status, "cancelled");
	assert.equal(result.cancelledReason, "abort");
	assert.equal(registry.hasPending(), false, "an aborted call must not queue anything");
});

test("an already-aborted call never renders an interactive UI", async () => {
	let rendered = false;
	const host: AskUserHost = {
		name: "custom",
		customUI: {
			render: async () => {
				rendered = true;
				return { kind: "cancelled" };
			},
		},
	};
	const controller = new AbortController();
	controller.abort();
	const result = await askUser(BASIC, { host, signal: controller.signal });
	assert.equal(result.status, "cancelled");
	assert.equal(rendered, false);
});

test("the abort listener installed on the caller signal is always removed", async () => {
	const host: AskUserHost = { name: "custom", customUI: { render: async () => ({ kind: "cancelled" }) } };
	const controller = new AbortController();
	for (let index = 0; index < 5; index += 1) {
		await askUser(BASIC, { host, signal: controller.signal });
	}
	assert.equal(
		getEventListeners(controller.signal, "abort").length,
		0,
		"no listeners may accumulate across calls",
	);
});

test("a timeout-path call also removes the caller listener", async () => {
	const host: AskUserHost = { name: "custom", customUI: { render: () => new Promise<never>(() => {}) } };
	const controller = new AbortController();
	await askUser({ questions: [{ title: "A" }], timeoutPerQuestionMs: 30 }, { host, signal: controller.signal });
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("an oversized timeout is clamped instead of firing immediately", async () => {
	const host: AskUserHost = { name: "custom", customUI: { render: async () => ({ kind: "cancelled" }) } };
	const result = await askUser(
		{ questions: [{ title: "A" }], timeoutPerQuestionMs: Number.MAX_SAFE_INTEGER },
		{ host },
	);
	// Without clamping, setTimeout would overflow to 1ms and produce a timeout.
	assert.equal(result.status, "cancelled");
});

test("invalid requests fail with invalid_request", async () => {
	const result = await askUser({ questions: [] }, { host: answeredHost() });
	assert.equal(result.status, "error");
	assert.equal(result.error?.code, "invalid_request");
});

test("createDeadline clamps oversized totals and treats 0 as immediately expired", () => {
	const deadline = createDeadline(Number.MAX_SAFE_INTEGER, () => 0);
	assert.equal(deadline.expiresAt - deadline.startedAt, MAX_SAFE_TIMEOUT_MS);
	const zero = createDeadline(0, () => 0);
	assert.equal(zero.expired(), true);
});

test("empty submitted answers are rejected as empty_answer", async () => {
	const result = await askUser(BASIC, {
		host: {
			name: "custom",
			customUI: {
				render: async () => ({
					kind: "submitted",
					answers: [{ index: 0, id: "q1", title: "Deploy where?", kind: "single", selections: [], usedDefault: false }],
				}),
			},
		},
	});
	assert.equal(result.status, "error");
	assert.equal(result.error?.code, "empty_answer");
});

test("normalization warnings travel with the result", async () => {
	const result = await askUser(
		{ questions: [{ title: "Q", options: ["a", "a", "b"] }] },
		{ host: answeredHost() },
	);
	assert.ok(result.warnings && result.warnings.some((warning) => /重复选项/.test(warning)));
	void (undefined as unknown as NormalizedRequest);
});
