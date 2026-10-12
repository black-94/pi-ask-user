import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createPiCustomRenderer } from "../src/adapters/pi.ts";
import { askUser } from "../src/core.ts";
import { createDeadline } from "../src/deadline.ts";
import { createAskUserHost } from "../src/route.ts";
import { normalizeAskUserRequest } from "../src/schema.ts";
import { AskUserComponent, type AskUserTheme, type CustomUIResult } from "../src/ui/custom.ts";
import type { AskUIInput, AskUIOutcome } from "../src/types.ts";

const theme: AskUserTheme = { fg: (_color, text) => text, bold: (text) => text };
const ALT_Q = "\x1bq";
const KITTY_ALT_Q = "\x1b[113;3u";
const KITTY_ALT_Q_REPEAT = "\x1b[113;3:2u";
const KITTY_ALT_Q_RELEASE = "\x1b[113;3:3u";
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => { resolve = res; });
	return { promise, resolve };
}

const submitted: AskUIOutcome = {
	kind: "submitted",
	answers: [{ index: 0, id: "q1", title: "Q", kind: "input", selections: [], freeText: "answer", usedDefault: false }],
};

test("a cancelled deadline never expires and cancellation is idempotent", () => {
	let now = 0;
	const deadline = createDeadline(100, () => now);
	assert.equal(deadline.cancel(), true);
	now = 200;
	assert.equal(deadline.cancel(), true);
	assert.equal(deadline.expired(), false);
	assert.equal(deadline.remainingMs(), Infinity);
	assert.equal(deadline.expiresAt, Infinity);
	assert.equal(deadline.startedAt, 0);
	const next = createDeadline(100, () => now);
	assert.equal(next.remainingMs(), 100, "the next questionnaire retains its own timeout");
});

test("an expired deadline cannot be revived", () => {
	let now = 0;
	const deadline = createDeadline(100, () => now);
	now = 100;
	assert.equal(deadline.cancel(), false);
	assert.equal(deadline.expired(), true);
	assert.equal(createDeadline(0, () => now).cancel(), false);
});

test("core timer cancellation works before and after the race is installed", async () => {
	for (const synchronous of [true, false]) {
		const pending = deferred<AskUIOutcome>();
		let input!: AskUIInput;
		let settled = false;
		const controller = new AbortController();
		const host = createAskUserHost({
			name: "test",
			customUI: { render(value) {
				input = value;
				if (synchronous) assert.equal(input.cancelTimeout?.(), true);
				return pending.promise;
			} },
		});
		const result = askUser({ questions: [{ title: "Q" }], timeoutPerQuestionMs: 100 }, { host, signal: controller.signal });
		void result.then(() => { settled = true; });
		try {
			if (!synchronous) assert.equal(input.cancelTimeout?.(), true);
			assert.equal(input.cancelTimeout?.(), true);
			await delay(150);
			assert.equal(settled, false, "cancellation must clear the core timeout, not merely the displayed countdown");
			assert.equal(input.signal?.aborted, false);
			pending.resolve(submitted);
			assert.equal((await result).status, "answered");
			assert.equal(getEventListeners(controller.signal, "abort").length, 0);
		} finally {
			controller.abort();
			await result;
		}
	}
});

test("caller abort remains effective after timeout cancellation even if the renderer never resolves", async () => {
	let input!: AskUIInput;
	const controller = new AbortController();
	const host = createAskUserHost({
		name: "test",
		customUI: { render(value) { input = value; return new Promise<never>(() => {}); } },
	});
	const result = askUser({ questions: [{ title: "Q" }], timeoutPerQuestionMs: 10_000 }, { host, signal: controller.signal });
	assert.equal(input.cancelTimeout?.(), true);
	controller.abort();
	assert.equal((await result).cancelledReason, "abort");
	assert.equal(input.signal?.aborted, true);
	assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("dismissing after the original deadline is a user dismissal, not a timeout", async () => {
	let now = 0;
	const pending = deferred<AskUIOutcome>();
	const host = createAskUserHost({
		name: "test",
		customUI: { render(input) { input.cancelTimeout?.(); return pending.promise; } },
	});
	const result = askUser({ questions: [{ title: "Q" }], timeoutPerQuestionMs: 100 }, { host, now: () => now });
	now = 200;
	pending.resolve({ kind: "cancelled" });
	assert.equal((await result).cancelledReason, "user");
});

test("native route does not expose timeout cancellation", async () => {
	const host = createAskUserHost({
		name: "test",
		nativeDialogs: { async run(input) { assert.equal(input.cancelTimeout, undefined); return submitted; } },
	});
	assert.equal((await askUser({ questions: [{ title: "Q" }] }, { host })).status, "answered");
});

for (const displayMode of ["overlay", "inline"] as const) {
	test(`${displayMode}: Alt+Q cancels both timers through the real Pi adapter and preserves drafts`, async () => {
		let component!: AskUserComponent;
		let renders = 0;
		const pending = deferred<CustomUIResult>();
		const controller = new AbortController();
		const ui = {
			custom(factory: Parameters<ExtensionUIContext["custom"]>[0]) {
				component = factory(
					{ requestRender: () => { renders += 1; }, terminal: { rows: 24 } } as never,
					theme as never, {} as never, pending.resolve as never,
				) as AskUserComponent;
				return pending.promise;
			},
		} as unknown as ExtensionUIContext;
		const host = createAskUserHost({ name: "pi", customUI: createPiCustomRenderer(ui, { overlayToggleKey: null }) });
		let settled = false;
		const result = askUser({ questions: [{ title: "Q" }], displayMode, timeoutPerQuestionMs: 100 }, { host, signal: controller.signal });
		void result.then(() => { settled = true; });
		try {
			assert.match(component.render(80).join("\n"), /alt\+q stop timer/);
			component.handleInput("answer");
			component.handleInput(displayMode === "overlay" ? ALT_Q : KITTY_ALT_Q);
			component.handleInput(KITTY_ALT_Q_REPEAT);
			component.handleInput(KITTY_ALT_Q_RELEASE);
			const afterCancel = renders;
			await delay(300);
			assert.equal(settled, false);
			assert.equal(renders, afterCancel, "the countdown interval must stop too");
			assert.match(component.render(80).join("\n"), /No timeout/);
			assert.doesNotMatch(component.render(80).join("\n"), /alt\+q stop timer/);
			for (const width of [1, 16, 20, 40, 80, 100]) {
				assert.ok(component.render(width).every((line) => visibleWidth(line) <= width));
			}
			component.handleInput("\r");
			const answer = await result;
			assert.equal(answer.status, "answered");
			assert.equal(answer.answers[0]?.freeText, "answer");
		} finally {
			controller.abort();
			component.dispose();
			await result;
		}
	});
}

test("the shortcut is available on options and review tabs; Esc still dismisses", () => {
	const request = normalizeAskUserRequest({
		questions: [{ title: "First", options: [{ label: "A" }] }, { title: "Second" }],
	}).request;
	for (const review of [false, true]) {
		let result: CustomUIResult | undefined;
		const getResult = () => result;
		let cancellations = 0;
		const component = new AskUserComponent({
			request, deadline: createDeadline(10_000), theme,
			tui: { requestRender: () => {}, terminal: { rows: 24 } },
			cancelTimeout: () => { cancellations += 1; return true; },
			done: (value) => { result = value; },
		});
		try {
			if (review) component.handleInput("\x1b[Z");
			component.handleInput(KITTY_ALT_Q_RELEASE);
			assert.equal(cancellations, 0, "a Kitty release is not a key press");
			component.handleInput(ALT_Q);
			component.handleInput(KITTY_ALT_Q_REPEAT);
			assert.equal(cancellations, 1);
			assert.equal(getResult(), undefined);
			assert.match(component.render(100).join("\n"), /No timeout/);
			component.handleInput("\x1b");
			assert.equal(getResult()?.kind, "cancelled");
		} finally {
			component.dispose();
		}
	}
});

test("the component does not hide the countdown if core refuses cancellation", () => {
	const request = normalizeAskUserRequest({ questions: [{ title: "Q" }] }).request;
	const component = new AskUserComponent({
		request, deadline: createDeadline(10_000), theme,
		tui: { requestRender: () => {}, terminal: { rows: 24 } },
		cancelTimeout: () => false, done: () => {},
	});
	try {
		component.handleInput(ALT_Q);
		assert.doesNotMatch(component.render(100).join("\n"), /No timeout/);
	} finally {
		component.dispose();
	}
});
