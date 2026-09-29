import assert from "node:assert/strict";
import { test } from "node:test";
import { UI_MODES, isUIMode } from "../src/mode.ts";
import { askUserSupport, createAskUserHost, hostCapabilities, probeRoutes } from "../src/route.ts";

const customUI = { render: async () => ({ kind: "cancelled" as const }) };
const nativeDialogs = { run: async () => ({ kind: "cancelled" as const }) };

test("capabilities are derived from implementations, not booleans", () => {
	assert.deepEqual(hostCapabilities({}), { customUI: false, nativeDialogs: false });
	assert.deepEqual(hostCapabilities({ nativeDialogs }), { customUI: false, nativeDialogs: true });
	assert.deepEqual(hostCapabilities({ customUI, nativeDialogs }), { customUI: true, nativeDialogs: true });
});

test("a declared capability without a callable implementation is not a capability", () => {
	// Simulates a host trying to declare customUI without a render method.
	const fake = { customUI: {} as unknown as typeof customUI };
	assert.equal(hostCapabilities(fake).customUI, false);
});

test("probe order prefers custom when both modes can run", () => {
	assert.deepEqual(probeRoutes({ customUI: true, nativeDialogs: true }), ["custom", "native"]);
	assert.deepEqual(probeRoutes({ customUI: true, nativeDialogs: false }), ["custom"]);
	assert.deepEqual(probeRoutes({ customUI: false, nativeDialogs: true }), ["native"]);
	assert.deepEqual(probeRoutes({ customUI: false, nativeDialogs: false }), []);
});

// --- no explicit config: initialisation-time probe, 0 / 1 / 2 capabilities ---

test("two capabilities without config probe to custom (priority)", () => {
	const host = createAskUserHost({ name: "both", customUI, nativeDialogs });
	assert.equal(askUserSupport(host), host.support, "the public accessor returns the resolved support");
	assert.deepEqual(host.support, {
		status: "available",
		route: "custom",
		source: "probed",
		capabilities: { customUI: true, nativeDialogs: true },
		available: ["custom", "native"],
	});
});

test("native-only without config probes to native", () => {
	const host = createAskUserHost({ name: "native", nativeDialogs });
	assert.equal(host.support.status, "available");
	if (host.support.status === "available") {
		assert.equal(host.support.route, "native");
		assert.equal(host.support.source, "probed");
		assert.deepEqual(host.support.available, ["native"]);
	}
});

test("custom-only without config probes to custom", () => {
	const host = createAskUserHost({ name: "custom", customUI });
	assert.equal(host.support.status, "available");
	if (host.support.status === "available") {
		assert.equal(host.support.route, "custom");
		assert.equal(host.support.source, "probed");
		assert.deepEqual(host.support.available, ["custom"]);
	}
});

test("no capability without config is no_available_ui and never fabricates a route", () => {
	const host = createAskUserHost({ name: "plain" });
	assert.equal(host.support.status, "no_available_ui");
	assert.equal("route" in host.support, false, "no route may be fabricated");
	assert.deepEqual(host.support.available, []);
	assert.deepEqual(host.support.capabilities, { customUI: false, nativeDialogs: false });
});

// --- explicit config wins over the probe ---

test("an explicit config wins over the probed route", () => {
	const host = createAskUserHost({ name: "both", mode: "native", customUI, nativeDialogs });
	assert.equal(host.support.status, "available");
	if (host.support.status === "available") {
		assert.equal(host.support.route, "native");
		assert.equal(host.support.source, "configured");
	}
});

test("an explicit config that matches a capability is honoured", () => {
	const host = createAskUserHost({ name: "both", mode: "custom", customUI, nativeDialogs });
	assert.equal(host.support.status, "available");
	if (host.support.status === "available") assert.equal(host.support.route, "custom");
});

// --- configured but unavailable: no fallback to the probed mode ---

test("configured custom with only native available is configured_unavailable, not native", () => {
	const host = createAskUserHost({ name: "native-only", mode: "custom", nativeDialogs });
	assert.equal(host.support.status, "configured_unavailable");
	if (host.support.status === "configured_unavailable") {
		assert.equal(host.support.configured, "custom");
		assert.deepEqual(host.support.available, ["native"]);
		assert.match(host.support.reason, /no other mode will be used/i);
	}
});

test("configured native with only custom available is configured_unavailable", () => {
	const host = createAskUserHost({ name: "custom-only", mode: "native", customUI });
	assert.equal(host.support.status, "configured_unavailable");
	if (host.support.status === "configured_unavailable") {
		assert.equal(host.support.configured, "native");
		assert.deepEqual(host.support.available, ["custom"]);
	}
});

test("configured custom with nothing available is configured_unavailable", () => {
	const host = createAskUserHost({ name: "plain", mode: "custom" });
	assert.equal(host.support.status, "configured_unavailable");
	if (host.support.status === "configured_unavailable") {
		assert.deepEqual(host.support.available, []);
		assert.match(host.support.reason, /no usable interactive UI/i);
	}
});

// --- invalid configuration ---

test("an unknown config value is invalid_config and still reports what could run", () => {
	const host = createAskUserHost({ name: "both", mode: "bogus" as never, customUI, nativeDialogs });
	assert.equal(host.support.status, "invalid_config");
	if (host.support.status === "invalid_config") {
		assert.deepEqual(host.support.available, ["custom", "native"]);
		assert.match(host.support.reason, /custom, native/);
	}
});

test("UI_MODES and isUIMode cover exactly the two supported routes", () => {
	assert.deepEqual([...UI_MODES], ["custom", "native"]);
	assert.equal(isUIMode("custom"), true);
	assert.equal(isUIMode("native"), true);
	assert.equal(isUIMode("bogus"), false);
	assert.equal(isUIMode(undefined), false);
});
