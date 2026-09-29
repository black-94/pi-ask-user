import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createPiHost } from "../src/adapters/pi.ts";
import {
	AskUserConfigError,
	DEFAULT_OVERLAY_TOGGLE_KEY,
	USER_CONFIG_DIR,
	USER_CONFIG_PATH,
	isAllowedOverlayToggleSpec,
	resolveAskUserConfig,
} from "../src/config.ts";
import { askUserNormalized } from "../src/core.ts";
import { createAskUserHost } from "../src/route.ts";
import { normalizeAskUserRequest } from "../src/schema.ts";
import type { NormalizedRequest } from "../src/types.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-ask-user-config-"));
let counter = 0;

/** Write a config file in a fresh temp path and return it. */
function writeConfig(contents: string | undefined): string {
	const path = join(dir, `settings-${counter++}.json`);
	if (contents !== undefined) writeFileSync(path, contents, "utf8");
	return path;
}

function configFileFor(value: unknown): string {
	return writeConfig(JSON.stringify(value));
}

test.after(() => rmSync(dir, { recursive: true, force: true }));

// --- defaults and missing file ---

test("the default config path is ~/.pi/ask-user/config.json", () => {
	assert.equal(USER_CONFIG_DIR, join(homedir(), ".pi", "ask-user"));
	assert.equal(USER_CONFIG_PATH, join(USER_CONFIG_DIR, "config.json"));
});

test("a missing config file means built-in defaults (nothing configured)", () => {
	const path = writeConfig(undefined);
	const resolved = resolveAskUserConfig({}, { configFile: path });
	assert.equal(resolved.error, undefined);
	assert.equal(resolved.loaded, false);
	assert.deepEqual(resolved.config, {});
	assert.equal(resolved.path, path);
});

test("an empty file is treated as no configuration", () => {
	const resolved = resolveAskUserConfig({}, { configFile: writeConfig("\n  \n") });
	assert.equal(resolved.error, undefined);
	assert.equal(resolved.loaded, false);
	assert.deepEqual(resolved.config, {});
});

test("configFile:false skips the file entirely", () => {
	const resolved = resolveAskUserConfig({ displayMode: "inline" }, { configFile: false });
	assert.equal(resolved.error, undefined);
	assert.equal(resolved.loaded, false);
	assert.equal(resolved.path, undefined);
	assert.deepEqual(resolved.config, { displayMode: "inline" });
});

// --- valid file ---

test("a valid file resolves every knob", () => {
	const path = configFileFor({
		mode: "native",
		displayMode: "inline",
		overlayToggleKey: "ctrl+g",
		timeoutPerQuestionMs: 1234,
	});
	const resolved = resolveAskUserConfig({}, { configFile: path });
	assert.equal(resolved.error, undefined);
	assert.equal(resolved.loaded, true);
	assert.deepEqual(resolved.config, {
		mode: "native",
		displayMode: "inline",
		overlayToggleKey: "ctrl+g",
		timeoutPerQuestionMs: 1234,
	});
});

test("overlayToggleKey accepts explicit disable sentinels and null", () => {
	for (const value of [null, "off", "none", "disabled", ""]) {
		const resolved = resolveAskUserConfig({}, { configFile: configFileFor({ overlayToggleKey: value }) });
		assert.equal(resolved.error, undefined, JSON.stringify(value));
		assert.equal(resolved.config.overlayToggleKey, null, JSON.stringify(value));
	}
});

test("overlayToggleKey normalizes case and whitespace", () => {
	const resolved = resolveAskUserConfig({}, { configFile: configFileFor({ overlayToggleKey: "  ALT+O  " }) });
	assert.equal(resolved.config.overlayToggleKey, "alt+o");
});

// --- invalid file: actionable errors, never thrown ---

test("invalid JSON is an actionable invalid_config error naming the file", () => {
	const path = writeConfig("{ not json ");
	const resolved = resolveAskUserConfig({}, { configFile: path });
	assert.ok(resolved.error instanceof AskUserConfigError);
	assert.equal(resolved.error!.code, "invalid_config");
	assert.match(resolved.error!.message, /not valid JSON/);
	assert.match(resolved.error!.message, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
	assert.deepEqual(resolved.config, {});
});

test("an unknown key is rejected and lists the allowed keys", () => {
	const resolved = resolveAskUserConfig({}, { configFile: configFileFor({ theme: "dark" }) });
	assert.ok(resolved.error);
	assert.match(resolved.error!.message, /unknown key "theme"/);
	assert.match(resolved.error!.message, /mode, displayMode, overlayToggleKey, timeoutPerQuestionMs/);
});

test("a non-object config is rejected", () => {
	for (const value of [[1, 2, 3], "mode", 42, null]) {
		const resolved = resolveAskUserConfig({}, { configFile: configFileFor(value) });
		assert.ok(resolved.error, JSON.stringify(value));
		assert.match(resolved.error!.message, /must be a JSON object/);
	}
});

test("bad values are rejected with the offending field named", () => {
	const cases: Array<[Record<string, unknown>, RegExp]> = [
		[{ mode: "auto" }, /"mode" must be "custom" or "native"/],
		[{ mode: null }, /"mode" must be "custom" or "native"/],
		[{ displayMode: "modal" }, /"displayMode" must be "overlay" or "inline"/],
		[{ overlayToggleKey: 7 }, /"overlayToggleKey" must be a key chord/],
		[{ overlayToggleKey: "alt++o" }, /not a supported key/],
		[{ overlayToggleKey: "alt+banana" }, /not a supported key/],
		[{ timeoutPerQuestionMs: -1 }, /"timeoutPerQuestionMs" must be a non-negative finite number/],
		[{ timeoutPerQuestionMs: "soon" }, /"timeoutPerQuestionMs" must be a non-negative finite number/],
	];
	for (const [value, pattern] of cases) {
		const resolved = resolveAskUserConfig({}, { configFile: configFileFor(value) });
		assert.ok(resolved.error, JSON.stringify(value));
		assert.equal(resolved.error!.code, "invalid_config");
		assert.match(resolved.error!.message, pattern, JSON.stringify(value));
	}
});

test("reserved and conflicting toggle keys are rejected, never substituted", () => {
	const rejected: Array<[string, RegExp]> = [
		["escape", /reserved by the questionnaire/i],
		["esc", /reserved by the questionnaire/i],
		["enter", /reserved by the questionnaire/i],
		["tab", /reserved by the questionnaire/i],
		["space", /reserved by the questionnaire/i],
		["up", /reserved by the questionnaire/i],
		["ctrl+c", /conflicts with a questionnaire control/i],
		["ctrl+enter", /reserved by the questionnaire/i],
		["o", /would capture ordinary typing/i],
	];
	for (const [spec, pattern] of rejected) {
		const resolved = resolveAskUserConfig({}, { configFile: configFileFor({ overlayToggleKey: spec }) });
		assert.ok(resolved.error, spec);
		assert.equal(resolved.error!.code, "invalid_config", spec);
		assert.match(resolved.error!.message, pattern, spec);
	}

	// Valid chords survive.
	for (const spec of ["alt+o", "ctrl+g", "alt+shift+p", "f5", "super+k"]) {
		const resolved = resolveAskUserConfig({}, { configFile: configFileFor({ overlayToggleKey: spec }) });
		assert.equal(resolved.error, undefined, spec);
		assert.equal(resolved.config.overlayToggleKey, spec);
	}
});

test("isAllowedOverlayToggleSpec matches the config decision", () => {
	assert.equal(isAllowedOverlayToggleSpec("alt+o"), true);
	assert.equal(isAllowedOverlayToggleSpec("f5"), true);
	assert.equal(isAllowedOverlayToggleSpec("escape"), false);
	assert.equal(isAllowedOverlayToggleSpec("ctrl+c"), false);
	assert.equal(isAllowedOverlayToggleSpec("o"), false);
	assert.equal(isAllowedOverlayToggleSpec("alt+banana"), false);
});

// --- precedence: programmatic option > file > builtin ---

test("every knob resolves as programmatic > file", () => {
	const path = configFileFor({
		mode: "native",
		displayMode: "inline",
		overlayToggleKey: "ctrl+g",
		timeoutPerQuestionMs: 1000,
	});
	const resolved = resolveAskUserConfig(
		{ mode: "custom", displayMode: "overlay", overlayToggleKey: "alt+o", timeoutPerQuestionMs: 2000 },
		{ configFile: path },
	);
	assert.deepEqual(resolved.config, {
		mode: "custom",
		displayMode: "overlay",
		overlayToggleKey: "alt+o",
		timeoutPerQuestionMs: 2000,
	});
});

test("an explicit null toggle overrides a file value", () => {
	const path = configFileFor({ overlayToggleKey: "ctrl+g" });
	const resolved = resolveAskUserConfig({ overlayToggleKey: null }, { configFile: path });
	assert.equal(resolved.error, undefined);
	assert.equal("overlayToggleKey" in resolved.config, true);
	assert.equal(resolved.config.overlayToggleKey, null);
});

test("programmatic displayMode/timeout/toggle are validated too", () => {
	const bad = resolveAskUserConfig({ displayMode: "modal" as never }, { configFile: false });
	assert.ok(bad.error);
	assert.match(bad.error!.message, /"displayMode" must be "overlay" or "inline"/);
	assert.match(bad.error!.message, /programmatic options/);

	const badTimeout = resolveAskUserConfig({ timeoutPerQuestionMs: -5 }, { configFile: false });
	assert.ok(badTimeout.error);
	assert.match(badTimeout.error!.message, /"timeoutPerQuestionMs" must be a non-negative finite number/);
});

test("an invalid programmatic mode is NOT rejected here; route resolution reports it", () => {
	// resolveSupport() owns the `invalid_config` message that names runnable modes.
	const resolved = resolveAskUserConfig({ mode: "bogus" as never }, { configFile: false });
	assert.equal(resolved.error, undefined);
	assert.equal(resolved.config.mode, "bogus");
});

test("the file is read at resolution time, not cached across resolutions", () => {
	const path = writeConfig(JSON.stringify({ displayMode: "inline" }));
	const first = resolveAskUserConfig({}, { configFile: path });
	assert.equal(first.config.displayMode, "inline");
	writeFileSync(path, JSON.stringify({ displayMode: "overlay" }), "utf8");
	const second = resolveAskUserConfig({}, { configFile: path });
	assert.equal(second.config.displayMode, "overlay");
});

test("DEFAULT_OVERLAY_TOGGLE_KEY is the documented alt+o", () => {
	assert.equal(DEFAULT_OVERLAY_TOGGLE_KEY, "alt+o");
});

// --- integration: read timing and effective precedence at the core ---

function noUICtx(): ExtensionContext {
	return { mode: "json", hasUI: false, ui: {} } as unknown as ExtensionContext;
}

function rpcCtx(): ExtensionContext {
	return { mode: "rpc", hasUI: true, ui: { input: async () => "1" } } as unknown as ExtensionContext;
}

test("createPiHost resolves the user config once at host creation, not per request", () => {
	const path = writeConfig(JSON.stringify({ displayMode: "inline", timeoutPerQuestionMs: 111 }));
	const host = createPiHost(noUICtx(), { configFile: path });
	assert.equal(host.preferences?.displayMode, "inline");
	assert.equal(host.preferences?.timeoutPerQuestionMs, 111);
	// Rewriting the file afterwards does not change the already-created host.
	writeFileSync(path, JSON.stringify({ displayMode: "overlay", timeoutPerQuestionMs: 222 }), "utf8");
	assert.equal(host.preferences?.displayMode, "inline");
	assert.equal(host.preferences?.timeoutPerQuestionMs, 111);
});

test("an invalid config file makes the host unusable, never a fallback", () => {
	const host = createPiHost(rpcCtx(), { configFile: writeConfig("{ bad json") });
	assert.equal(host.support.status, "invalid_config");
	if (host.support.status === "invalid_config") {
		assert.match(host.support.reason, /not valid JSON/);
		// Capabilities are still probed so the error can name what could run.
		assert.deepEqual(host.support.available, ["native"]);
	}
});

test("an invalid programmatic value also makes the host unusable", () => {
	const host = createPiHost(rpcCtx(), { displayMode: "modal" as never, configFile: false });
	assert.equal(host.support.status, "invalid_config");
	if (host.support.status === "invalid_config") assert.match(host.support.reason, /"displayMode" must be "overlay" or "inline"/);
});

test("a reserved toggle key makes the host unusable with an actionable reason", () => {
	const fileHost = createPiHost(rpcCtx(), { configFile: configFileFor({ overlayToggleKey: "escape" }) });
	assert.equal(fileHost.support.status, "invalid_config");
	if (fileHost.support.status === "invalid_config") {
		assert.match(fileHost.support.reason, /reserved by the questionnaire/i);
		assert.match(fileHost.support.reason, /Esc cancels/i);
	}
	const optionsHost = createPiHost(rpcCtx(), { overlayToggleKey: "ctrl+c", configFile: false });
	assert.equal(optionsHost.support.status, "invalid_config");
	if (optionsHost.support.status === "invalid_config") {
		assert.match(optionsHost.support.reason, /conflicts with a questionnaire control/i);
	}
});

test("user displayMode/timeout preferences win over the model request", async () => {
	let captured: NormalizedRequest | undefined;
	const host = createAskUserHost({
		name: "test",
		preferences: { displayMode: "inline", timeoutPerQuestionMs: 250 },
		customUI: {
			render: async (input) => {
				captured = input.request;
				return { kind: "cancelled" };
			},
		},
	});
	const request = normalizeAskUserRequest({
		questions: [{ title: "A" }, { title: "B" }],
		displayMode: "overlay",
		timeoutPerQuestionMs: 9999,
	}).request;
	await askUserNormalized(request, { host });
	assert.equal(captured?.displayMode, "inline");
	assert.equal(captured?.timeoutPerQuestionMs, 250);
	assert.equal(captured?.totalTimeoutMs, 500, "the deadline is recomputed from the effective value");
});

test("without user preferences the request wins over the built-in default", async () => {
	let captured: NormalizedRequest | undefined;
	const host = createAskUserHost({
		name: "test",
		customUI: {
			render: async (input) => {
				captured = input.request;
				return { kind: "cancelled" };
			},
		},
	});
	const request = normalizeAskUserRequest({
		questions: [{ title: "A" }],
		displayMode: "inline",
		timeoutPerQuestionMs: 1234,
	}).request;
	await askUserNormalized(request, { host });
	assert.equal(captured?.displayMode, "inline");
	assert.equal(captured?.timeoutPerQuestionMs, 1234);
});

test("the resolved overlay toggle key reaches the host preferences", () => {
	const disabled = createPiHost(noUICtx(), { configFile: configFileFor({ overlayToggleKey: "off" }) });
	assert.equal(disabled.preferences?.overlayToggleKey, null);
	const defaulted = createPiHost(noUICtx(), { configFile: false });
	assert.equal("overlayToggleKey" in (defaulted.preferences ?? {}), false, "an unset toggle stays unset so alt+o applies");
});
