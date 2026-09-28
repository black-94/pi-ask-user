import type { AskUserHost, AskUserRoute, HostCapabilities } from "./types.ts";

/**
 * Derive declared capabilities from a host adapter.
 *
 * A capability is bound to the implementation object that performs it, so it is
 * impossible to declare `customUI` (or `nativeDialogs`) without a real renderer.
 * This is the anti-false-declaration guarantee: capabilities are structural, not
 * a boolean the caller can assert independently.
 */
export function hostCapabilities(host: AskUserHost): HostCapabilities {
	return {
		customUI: typeof host.customUI?.render === "function",
		nativeDialogs: typeof host.nativeDialogs?.run === "function",
	};
}

/**
 * Pick the route. Custom UI wins when declared; otherwise native dialogs; when
 * neither is declared the questionnaire becomes plain text. There is no probing
 * and no automatic downgrade: a declared route stays selected even if it is
 * cancelled, times out, or fails.
 */
export function pickRoute(capabilities: HostCapabilities): AskUserRoute {
	if (capabilities.customUI) return "custom";
	if (capabilities.nativeDialogs) return "native";
	return "plain_text";
}
