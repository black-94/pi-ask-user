import type { AskUserHost, HostCapabilities } from "./types.ts";

/**
 * Derive the structural capabilities of a host adapter.
 *
 * A capability is bound to the implementation object that performs it, so it is
 * impossible to declare `customUI` (or `nativeDialogs`) without a real renderer.
 * This is the anti-false-declaration guarantee: capabilities are structural, not
 * a boolean the caller can assert independently.
 *
 * Capabilities are used to verify that a **forced** mode can really run. They
 * are deliberately not used to choose a route: routing is configuration, and an
 * unsupported forced mode is an actionable error rather than a downgrade.
 */
export function hostCapabilities(host: AskUserHost): HostCapabilities {
	return {
		customUI: typeof host.customUI?.render === "function",
		nativeDialogs: typeof host.nativeDialogs?.run === "function",
	};
}
