import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import { askUser } from "../src/core.ts";
import { createDeadline, MAX_SAFE_TIMEOUT_MS } from "../src/deadline.ts";
import { createAskUserHost } from "../src/route.ts";
import type { AskUIInput, AskUIOutcome, AskUserHost, CustomUIRenderer, NativeDialogRunner } from "../src/types.ts";

const BASIC = {
	questions: [
		{ title: "Deploy where?", kind: "single", options: [{ label: "staging" }, { label: "prod" }] },
	],
};

const SUBMITTED: AskUIOutcome = {
	kind: "submitted",
	answers: [
		{ index: 0, id: "q1", title: "Deploy where?", kind: "single", selections: ["prod"], usedDefault: false },
	],
};

const rendersSubmitted: CustomUIRenderer = { render: async () => SUBMITTED };
const runsSubmitted: NativeDialogRunner = { run: async () => SUBMITTED };
const unusedCustom: CustomUIRenderer = {
	render: async () => {
		throw new Error("the custom renderer must not run");
	},
};
const unusedNative: NativeDialogRunner = {
	run: async () => {
		throw new Error("the native runner must not run");
	},
};

test("a host with both capabilities and no config answers through custom (probe priority)", async () => {
	const host = createAskUserHost({ name: "both", customUI: rendersSubmitted, nativeDialogs: unusedNative });
	const result = await askUser(BASIC, { host });
	assert.equal(result.status, "answered");
	assert.equal(result.route, "custom");
	assert.deepEqual(result.answers[0]!.selections, ["prod"]);
});

test("a native-only host answers through native", async () => {
	const host = createAskUserHost({ name: "native", nativeDialogs: runsSubmitted });
	const result = await askUser(BASIC, { host });
	assert.equal(result.status, "answered");
	assert.equal(result.route, "native");
});

test("an explicit native config beats the probed custom route", async () => {
	const host = createAskUserHost({
		name: "both",
		mode: "native",
		customUI: unusedCustom,
		nativeDialogs: runsSubmitted,
	});
	const result = await askUser(BASIC, { host });
	assert.equal(result.status, "answered");
	assert.equal(result.route, "native");
});

test("a host with no capability is an actionable error with no route and no fallback", async () => {
	const host = createAskUserHost({ name: "plain" });
	const result = await askUser(BASIC, { host });
	assert.equal(result.status, "error");
	assert.equal(result.error?.code, "unsupported_mode");
	assert.equal(result.route, undefined, "no route may be fabricated");
	assert.deepEqual(result.answers, []);
	assert.match(result.error?.message ?? "", /no usable interactive UI/i);
});

test("a configured route that cannot run is refused, never substituted by the probed one", async () => {
	let nativeCalled = false;
	const host = createAskUserHost({
		name: "native-only",
		mode: "custom",
		nativeDialogs: {
			run: async () => {
				nativeCalled = true;
				return SUBMITTED;
			},
		},
	});
	const result = await askUser(BASIC, { host });
	assert.equal(result.status, "error");
	assert.equal(result.error?.code, "unsupported_mode");
	assert.equal(result.route, "custom", "the requested configured route is named");
	assert.deepEqual(result.answers, []);
	assert.equal(nativeCalled, false, "the available native route must not be used as a fallback");
	assert.match(result.error?.message ?? "", /no other mode will be used/i);
});

test("a configured custom route with no capability at all is refused", async () => {
	const host = createAskUserHost({ name: "plain", mode: "custom" });
	const result = await askUser(BASIC, { host });
	assert.equal(result.status, "error");
	assert.equal(result.error?.code, "unsupported_mode");
	assert.equal(result.route, "custom");
});

test("an invalid configured mode is invalid_config, not a fallback", async () => {
	const host = createAskUserHost({
		name: "both",
		mode: "bogus" as never,
		customUI: rendersSubmitted,
		nativeDialogs: runsSubmitted,
	});
	const result = await askUser(BASIC, { host });
	assert.equal(result.status, "error");
	assert.equal(result.error?.code, "invalid_config");
	assert.equal(result.route, undefined);
	assert.match(result.error?.message ?? "", /custom, native/);
});

test("cancel, timeout, and error are distinguished and never degrade", async () => {
	let otherRouteCalled = false;
	const host = createAskUserHost({
		name: "custom",
		customUI: { render: async () => ({ kind: "cancelled" }) },
		nativeDialogs: {
			run: async () => {
				otherRouteCalled = true;
				return { kind: "cancelled" };
			},
		},
	});
	const aborted = await askUser(BASIC, { host });
	assert.equal(aborted.status, "aborted");
	assert.equal(aborted.cancelledReason, "user");
	assert.equal(otherRouteCalled, false);

	const timeoutHost = createAskUserHost({ name: "custom", customUI: { render: async () => ({ kind: "timeout" }) } });
	const timeout = await askUser(BASIC, { host: timeoutHost });
	assert.equal(timeout.status, "timeout");
	assert.equal(timeout.route, "custom");

	const errorHost = createAskUserHost({
		name: "custom",
		customUI: {
			render: async () => {
				throw new Error("boom");
			},
		},
	});
	const errored = await askUser(BASIC, { host: errorHost });
	assert.equal(errored.status, "error");
	assert.equal(errored.error?.code, "custom_ui_failed");
});

test("the shared deadline aborts and yields a timeout, not a fallback", async () => {
	let observedTotal = 0;
	let otherRouteCalled = false;
	const host = createAskUserHost({
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
				otherRouteCalled = true;
				return { kind: "cancelled" };
			},
		},
	});
	const result = await askUser(
		{ questions: [{ title: "A" }, { title: "B" }, { title: "C" }], timeoutPerQuestionMs: 20 },
		{ host },
	);
	assert.equal(result.status, "timeout");
	assert.equal(result.route, "custom");
	assert.equal(observedTotal, 60);
	assert.equal(otherRouteCalled, false);
});

test("a caller abort is reported as aborted/abort", async () => {
	const controller = new AbortController();
	const host = createAskUserHost({
		name: "custom",
		customUI: {
			render: (input) =>
				new Promise((resolve) => {
					const abort = () => resolve({ kind: "abort" as const });
					if (input.signal?.aborted) abort();
					else input.signal?.addEventListener("abort", abort, { once: true });
				}),
		},
	});
	const promise = askUser(BASIC, { host, signal: controller.signal });
	controller.abort();
	const result = await promise;
	assert.equal(result.status, "aborted");
	assert.equal(result.cancelledReason, "abort");
});

test("a renderer that never resolves still yields a timeout (core owns the guarantee)", async () => {
	const host = createAskUserHost({ name: "custom", customUI: { render: () => new Promise<never>(() => {}) } });
	const started = Date.now();
	const result = await askUser(
		{ questions: [{ title: "A" }, { title: "B" }], timeoutPerQuestionMs: 40 },
		{ host },
	);
	assert.equal(result.status, "timeout");
	assert.equal(result.route, "custom");
	assert.ok(Date.now() - started < 2000, "must not hang");
});

test("a caller abort returns promptly even when the renderer ignores signals", async () => {
	const host = createAskUserHost({
		name: "native",
		nativeDialogs: { run: () => new Promise<never>(() => {}) },
	});
	const controller = new AbortController();
	const promise = askUser(
		{ questions: [{ title: "A" }], timeoutPerQuestionMs: 100_000 },
		{ host, signal: controller.signal },
	);
	setTimeout(() => controller.abort(), 10);
	const result = await promise;
	assert.equal(result.status, "aborted");
	assert.equal(result.cancelledReason, "abort");
});

test("a native runner that never resolves also times out without degrading", async () => {
	const host = createAskUserHost({ name: "native", nativeDialogs: { run: () => new Promise<never>(() => {}) } });
	const result = await askUser(
		{ questions: [{ title: "A" }], timeoutPerQuestionMs: 40 },
		{ host },
	);
	assert.equal(result.status, "timeout");
	assert.equal(result.route, "native");
});

test("an already-aborted call never renders an interactive UI", async () => {
	let rendered = false;
	const host = createAskUserHost({
		name: "custom",
		customUI: {
			render: async () => {
				rendered = true;
				return { kind: "cancelled" };
			},
		},
	});
	const controller = new AbortController();
	controller.abort();
	const result = await askUser(BASIC, { host, signal: controller.signal });
	assert.equal(result.status, "aborted");
	assert.equal(rendered, false);
});

test("the abort listener installed on the caller signal is always removed", async () => {
	const host = createAskUserHost({ name: "custom", customUI: { render: async () => ({ kind: "cancelled" }) } });
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
	const host = createAskUserHost({ name: "custom", customUI: { render: () => new Promise<never>(() => {}) } });
	const controller = new AbortController();
	await askUser({ questions: [{ title: "A" }], timeoutPerQuestionMs: 30 }, { host, signal: controller.signal });
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("an oversized timeout is clamped instead of firing immediately", async () => {
	const host = createAskUserHost({ name: "custom", customUI: { render: async () => ({ kind: "cancelled" }) } });
	const result = await askUser(
		{ questions: [{ title: "A" }], timeoutPerQuestionMs: Number.MAX_SAFE_INTEGER },
		{ host },
	);
	// Without clamping, setTimeout would overflow to 1ms and produce a timeout.
	assert.equal(result.status, "aborted");
});

test("invalid requests fail with invalid_request before any route runs", async () => {
	const host = createAskUserHost({ name: "custom", customUI: rendersSubmitted });
	const result = await askUser({ questions: [] }, { host });
	assert.equal(result.status, "error");
	assert.equal(result.error?.code, "invalid_request");
	assert.equal(result.route, undefined);
});

test("createDeadline clamps oversized totals and treats 0 as immediately expired", () => {
	const deadline = createDeadline(Number.MAX_SAFE_INTEGER, () => 0);
	assert.equal(deadline.expiresAt - deadline.startedAt, MAX_SAFE_TIMEOUT_MS);
	const zero = createDeadline(0, () => 0);
	assert.equal(zero.expired(), true);
});

test("empty submitted answers are rejected as empty_answer", async () => {
	const host = createAskUserHost({
		name: "custom",
		customUI: {
			render: async () => ({
				kind: "submitted",
				answers: [{ index: 0, id: "q1", title: "Deploy where?", kind: "single", selections: [], usedDefault: false }],
			}),
		},
	});
	const result = await askUser(BASIC, { host });
	assert.equal(result.status, "error");
	assert.equal(result.error?.code, "empty_answer");
});

test("normalization warnings travel with the result", async () => {
	const host = createAskUserHost({ name: "custom", customUI: rendersSubmitted });
	const result = await askUser(
		{ questions: [{ title: "Q", options: [{ label: "a" }, { label: "a" }, { label: "b" }] }] },
		{ host },
	);
	assert.ok(result.warnings && result.warnings.some((warning) => /duplicate option/i.test(warning)));
	void (undefined as unknown as AskUserHost);
});
