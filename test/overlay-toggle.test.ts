import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle } from "@earendil-works/pi-tui";
import { createPiCustomRenderer, createPiHost } from "../src/adapters/pi.ts";
import { askUser, askUserNormalized } from "../src/core.ts";
import { createDeadline } from "../src/deadline.ts";
import { createAskUserHost } from "../src/route.ts";
import { normalizeAskUserRequest } from "../src/schema.ts";
import { AskUserComponent, type AskUserTheme, type CustomUIResult } from "../src/ui/custom.ts";
import type { NormalizedRequest } from "../src/types.ts";

const ALT_O = "\x1bo";
const ALT_O_REPEAT = "\x1b[111;3:2u";
const ALT_O_RELEASE = "\x1b[111;3:3u";

const theme: AskUserTheme = {
	fg: (_color, text) => text,
	bold: (text) => text,
	italic: (text) => text,
	underline: (text) => text,
	strikethrough: (text) => text,
	inverse: (text) => text,
};

type Listener = (data: string) => { consume?: boolean; data?: string } | undefined;

function request(input: unknown): NormalizedRequest {
	return normalizeAskUserRequest(input).request;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

interface OverlayHarness {
	ui: ExtensionUIContext;
	listeners: Set<Listener>;
	notices: Array<{ message: string; type?: string }>;
	handle: OverlayHandle;
	hiddenCalls: boolean[];
	pending: { promise: Promise<CustomUIResult>; resolve: (value: CustomUIResult) => void };
	overlay: () => boolean | undefined;
	width: () => number | string | undefined;
	minWidth: () => number | undefined;
	unsubscribeCount: () => number;
}

function overlayHarness(): OverlayHarness {
	const listeners = new Set<Listener>();
	const notices: Array<{ message: string; type?: string }> = [];
	const hiddenCalls: boolean[] = [];
	let hidden = false;
	let unsubscribes = 0;
	let capturedOverlay: boolean | undefined;
	let capturedWidth: number | string | undefined;
	let capturedMinWidth: number | undefined;
	const handle = {
		setHidden(value: boolean) {
			hidden = value;
			hiddenCalls.push(value);
		},
		isHidden() {
			return hidden;
		},
	} as unknown as OverlayHandle;
	const pending = deferred<CustomUIResult>();
	const ui = {
		onTerminalInput(listener: Listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
				unsubscribes += 1;
			};
		},
		notify(message: string, type?: string) {
			notices.push({ message, type });
		},
		async custom(_factory: unknown, opts?: { overlay?: boolean; overlayOptions?: { width?: number | string; minWidth?: number }; onHandle?: (handle: OverlayHandle) => void }) {
			capturedOverlay = opts?.overlay;
			capturedWidth = opts?.overlayOptions?.width;
			capturedMinWidth = opts?.overlayOptions?.minWidth;
			opts?.onHandle?.(handle);
			return pending.promise;
		},
	} as unknown as ExtensionUIContext;
	return {
		ui,
		listeners,
		notices,
		handle,
		hiddenCalls,
		pending,
		overlay: () => capturedOverlay,
		width: () => capturedWidth,
		minWidth: () => capturedMinWidth,
		unsubscribeCount: () => unsubscribes,
	};
}

const OVERLAY_REQUEST = request({ questions: [{ title: "Q", kind: "input" }] });

test("overlay registers one raw listener and hides/restores with the same key", async () => {
	const harness = overlayHarness();
	const renderer = createPiCustomRenderer(harness.ui, { overlayToggleKey: "alt+o" });
	const rendering = renderer.render({ request: OVERLAY_REQUEST, deadline: createDeadline(10_000) });
	await tick();
	assert.equal(harness.listeners.size, 1, "overlay must register exactly one listener");
	assert.equal(harness.width(), 96, "the overlay must not span a wide terminal");
	assert.equal(harness.minWidth(), 64, "the overlay must remain readable where room permits");
	const listener = [...harness.listeners][0]!;

	assert.deepEqual(listener(ALT_O), { consume: true });
	assert.equal(harness.handle.isHidden(), true, "the key hides the overlay");
	assert.equal(harness.notices.length, 1, "the first hide reveals a one-time restore notice");
	assert.match(harness.notices[0]!.message, /alt\+o/);

	// The same key restores it while hidden.
	assert.deepEqual(listener(ALT_O), { consume: true });
	assert.equal(harness.handle.isHidden(), false);
	assert.equal(harness.notices.length, 1, "the restore notice is shown only once");

	harness.pending.resolve({ kind: "cancelled" });
	assert.equal((await rendering).kind, "cancelled");
});

test("repeat and release events are consumed without toggling; unrelated keys pass through", async () => {
	const harness = overlayHarness();
	const renderer = createPiCustomRenderer(harness.ui, { overlayToggleKey: "alt+o" });
	const rendering = renderer.render({ request: OVERLAY_REQUEST, deadline: createDeadline(10_000) });
	await tick();
	const listener = [...harness.listeners][0]!;

	assert.deepEqual(listener(ALT_O_REPEAT), { consume: true });
	assert.deepEqual(listener(ALT_O_RELEASE), { consume: true });
	assert.deepEqual(harness.hiddenCalls, [], "repeat/release must not toggle visibility");
	assert.equal(listener("x"), undefined, "unrelated input is not consumed");
	assert.equal(harness.handle.isHidden(), false);

	harness.pending.resolve({ kind: "cancelled" });
	await rendering;
});

test("the listener and handle are released once the interaction settles", async () => {
	const harness = overlayHarness();
	const renderer = createPiCustomRenderer(harness.ui, { overlayToggleKey: "alt+o" });
	const rendering = renderer.render({ request: OVERLAY_REQUEST, deadline: createDeadline(10_000) });
	await tick();
	assert.equal(harness.listeners.size, 1);
	harness.pending.resolve({ kind: "timeout" });
	const outcome = await rendering;
	assert.equal(outcome.kind, "timeout");
	assert.equal(harness.unsubscribeCount(), 1, "the raw listener must be unsubscribed");
	assert.equal(harness.listeners.size, 0);
});

test("hiding does not resolve the interaction; the outcome still arrives", async () => {
	const harness = overlayHarness();
	const renderer = createPiCustomRenderer(harness.ui, { overlayToggleKey: "alt+o" });
	let settled = false;
	const rendering = renderer.render({ request: OVERLAY_REQUEST, deadline: createDeadline(10_000) });
	void rendering.then(() => {
		settled = true;
	});
	await tick();
	[...harness.listeners][0]!(ALT_O);
	await tick();
	assert.equal(harness.handle.isHidden(), true);
	assert.equal(settled, false, "hiding must not settle the interaction");
	harness.pending.resolve({ kind: "cancelled" });
	await rendering;
	assert.equal(settled, true);
});

test("inline custom registers no listener", async () => {
	const harness = overlayHarness();
	const renderer = createPiCustomRenderer(harness.ui, { overlayToggleKey: "alt+o" });
	const rendering = renderer.render({
		request: request({ questions: [{ title: "Q", kind: "input" }], displayMode: "inline" }),
		deadline: createDeadline(10_000),
	});
	await tick();
	assert.equal(harness.listeners.size, 0);
	assert.equal(harness.overlay(), false);
	harness.pending.resolve({ kind: "cancelled" });
	await rendering;
});

test("a disabled toggle key registers no listener", async () => {
	const harness = overlayHarness();
	const renderer = createPiCustomRenderer(harness.ui, { overlayToggleKey: null });
	const rendering = renderer.render({ request: OVERLAY_REQUEST, deadline: createDeadline(10_000) });
	await tick();
	assert.equal(harness.listeners.size, 0, "an explicitly disabled key must not register a listener");
	assert.equal(harness.overlay(), true);
	harness.pending.resolve({ kind: "cancelled" });
	await rendering;
});

test("an omitted key defaults to alt+o", async () => {
	const harness = overlayHarness();
	const renderer = createPiCustomRenderer(harness.ui);
	const rendering = renderer.render({ request: OVERLAY_REQUEST, deadline: createDeadline(10_000) });
	await tick();
	assert.equal(harness.listeners.size, 1);
	assert.deepEqual([...harness.listeners][0]!(ALT_O), { consume: true });
	assert.equal(harness.handle.isHidden(), true);
	harness.pending.resolve({ kind: "cancelled" });
	await rendering;
});

test("the native route never touches the terminal-input listener", async () => {
	let registered = 0;
	const ctx = {
		mode: "rpc",
		hasUI: true,
		ui: {
			input: async () => "1",
			onTerminalInput: () => {
				registered += 1;
				return () => {};
			},
		},
	} as unknown as ExtensionContext;
	const host = createPiHost(ctx, { configFile: false });
	const result = await askUser(
		{ questions: [{ title: "Q", kind: "single", options: [{ label: "a" }] }] },
		{ host },
	);
	assert.equal(result.status, "answered");
	assert.equal(registered, 0);
});

test("the component hints the overlay toggle only for overlay display", () => {
	const mount = (req: NormalizedRequest) => {
		let result: CustomUIResult | undefined;
		const component = new AskUserComponent({
			request: req,
			deadline: createDeadline(10_000),
			theme,
			tui: { requestRender: () => {}, terminal: { rows: 24, columns: 80 } },
			done: (value) => {
				result = value;
			},
			overlayToggleKey: "alt+o",
		});
		return { component, getResult: () => result };
	};

	const overlay = mount(request({ questions: [{ title: "Q", kind: "input" }] }));
	assert.match(overlay.component.render(80).join("\n"), /alt\+o hide/);

	const inline = mount(request({ questions: [{ title: "Q", kind: "input" }], displayMode: "inline" }));
	assert.doesNotMatch(inline.component.render(80).join("\n"), /alt\+o/);
});

// --- revision: cleanup must not depend on ui.custom resolving ---

test("a never-settling custom UI cannot leave the listener capturing keys after a core timeout", async () => {
	const harness = overlayHarness();
	// Simulate a renderer that ignores its AbortSignal and never resolves.
	(harness.ui as unknown as { custom: () => Promise<CustomUIResult> }).custom = () => new Promise<CustomUIResult>(() => {});
	const host = createAskUserHost({
		name: "test",
		customUI: createPiCustomRenderer(harness.ui, { overlayToggleKey: "alt+o" }),
	});
	const request = normalizeAskUserRequest({
		questions: [{ title: "Q", kind: "input" }],
		timeoutPerQuestionMs: 20,
	}).request;

	const rendering = askUserNormalized(request, { host });
	await tick();
	assert.equal(harness.listeners.size, 1, "the listener is registered while the UI is pending");
	const staleListener = [...harness.listeners][0]!;

	const result = await rendering;
	assert.equal(result.status, "timeout");
	assert.equal(harness.listeners.size, 0, "the raw listener must be removed on timeout");
	assert.equal(harness.unsubscribeCount(), 1, "unsubscribe must be called exactly once");
	// No UI side effects after termination: a stale reference is inert.
	assert.equal(staleListener(ALT_O), undefined);
	assert.deepEqual(harness.hiddenCalls, [], "no toggle may take effect after completion");
	assert.equal(harness.notices.length, 0);
});

test("a never-settling custom UI also cleans up on caller abort", async () => {
	const harness = overlayHarness();
	(harness.ui as unknown as { custom: () => Promise<CustomUIResult> }).custom = () => new Promise<CustomUIResult>(() => {});
	const host = createAskUserHost({
		name: "test",
		customUI: createPiCustomRenderer(harness.ui, { overlayToggleKey: "alt+o" }),
	});
	const request = normalizeAskUserRequest({ questions: [{ title: "Q", kind: "input" }] }).request;
	const controller = new AbortController();
	const rendering = askUserNormalized(request, { host, signal: controller.signal });
	await tick();
	assert.equal(harness.listeners.size, 1);
	controller.abort();
	const result = await rendering;
	assert.equal(result.status, "aborted");
	assert.equal(harness.listeners.size, 0, "the raw listener must be removed on abort");
	assert.equal(harness.unsubscribeCount(), 1);
	assert.deepEqual(harness.hiddenCalls, []);
});

test("cleanup is idempotent when abort and settle both run", async () => {
	const harness = overlayHarness();
	(harness.ui as unknown as { custom: () => Promise<CustomUIResult> }).custom = () => new Promise<CustomUIResult>(() => {});
	const host = createAskUserHost({
		name: "test",
		customUI: createPiCustomRenderer(harness.ui, { overlayToggleKey: "alt+o" }),
	});
	const request = normalizeAskUserRequest({ questions: [{ title: "Q", kind: "input" }] }).request;
	const controller = new AbortController();
	const rendering = askUserNormalized(request, { host, signal: controller.signal });
	await tick();
	controller.abort();
	await rendering;
	assert.equal(harness.unsubscribeCount(), 1, "cleanup must not run twice");
});

test("a reserved key passed directly to the renderer disables the listener", async () => {
	const harness = overlayHarness();
	const renderer = createPiCustomRenderer(harness.ui, { overlayToggleKey: "escape" });
	const rendering = renderer.render({ request: OVERLAY_REQUEST, deadline: createDeadline(10_000) });
	await tick();
	assert.equal(harness.listeners.size, 0, "a reserved key must not register a raw listener");
	harness.pending.resolve({ kind: "cancelled" });
	const outcome = await rendering;
	assert.equal(outcome.kind, "cancelled");
});

test("Esc still cancels the questionnaire while the alt+o toggle is registered", async () => {
	const listeners = new Set<Listener>();
	let component: AskUserComponent | undefined;
	const handle = {
		setHidden() {},
		isHidden() {
			return false;
		},
	} as unknown as OverlayHandle;
	const ui = {
		onTerminalInput(listener: Listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		notify() {},
		custom(
			factory: (tui: unknown, thm: unknown, kb: unknown, done: (r: CustomUIResult) => void) => unknown,
			opts?: { onHandle?: (h: OverlayHandle) => void },
		) {
			return new Promise<CustomUIResult>((resolve) => {
				opts?.onHandle?.(handle);
				component = factory(
					{ requestRender: () => {}, terminal: { rows: 24, columns: 80 } },
					theme,
					{},
					resolve,
				) as AskUserComponent;
			});
		},
	} as unknown as ExtensionUIContext;

	const renderer = createPiCustomRenderer(ui, { overlayToggleKey: "alt+o" });
	const rendering = renderer.render({ request: OVERLAY_REQUEST, deadline: createDeadline(10_000) });
	await tick();
	assert.equal(listeners.size, 1, "the toggle listener is registered but must not consume Esc");
	component!.handleInput("\x1b");
	const outcome = await rendering;
	assert.equal(outcome.kind, "cancelled", "Esc must still cancel");
	assert.equal(listeners.size, 0, "the listener is cleaned up on cancellation");
});
