import { isUIMode } from "./mode.ts";
import type {
	AskUserHost,
	AskUserMode,
	AskUserRoute,
	AskUserSupport,
	CustomUIRenderer,
	HostCapabilities,
	HostImplementations,
	NativeDialogRunner,
} from "./types.ts";

/**
 * Derive the structural capabilities of a host.
 *
 * A capability is bound to the implementation object that performs it, so it is
 * impossible to declare `customUI` (or `nativeDialogs`) without a real renderer.
 * This is the anti-false-declaration guarantee: capabilities are structural, not
 * a boolean the caller can assert independently.
 */
export function hostCapabilities(host: HostImplementations): HostCapabilities {
	return {
		customUI: typeof host.customUI?.render === "function",
		nativeDialogs: typeof host.nativeDialogs?.run === "function",
	};
}

/**
 * The modes that can really run here, in probe-priority order: `custom` first
 * when both are available, then `native`.
 */
export function probeRoutes(capabilities: HostCapabilities): AskUserRoute[] {
	const routes: AskUserRoute[] = [];
	if (capabilities.customUI) routes.push("custom");
	if (capabilities.nativeDialogs) routes.push("native");
	return routes;
}

/**
 * Resolve a host's route **once**, from the explicit configuration and the
 * probe result:
 *
 *  1. an explicit `mode` wins whenever it is supplied — if its implementation is
 *     bound it becomes the route (`source: "configured"`), otherwise the result
 *     is `configured_unavailable` and the other bound mode is *not* substituted;
 *  2. with no explicit `mode`, the probe result decides: `custom` when both can
 *     run, otherwise the single available mode (`source: "probed"`);
 *  3. with nothing available, the result is `no_available_ui` — no route is
 *     fabricated.
 */
export function resolveSupport(mode: AskUserMode | undefined, capabilities: HostCapabilities): AskUserSupport {
	const available = probeRoutes(capabilities);
	if (mode !== undefined) {
		if (!isUIMode(mode)) {
			return {
				status: "invalid_config",
				capabilities,
				available,
				reason: `Invalid UI mode ${JSON.stringify(mode)}; available modes: custom, native.`,
			};
		}
		const bound = mode === "custom" ? capabilities.customUI : capabilities.nativeDialogs;
		if (bound) {
			return { status: "available", route: mode, source: "configured", capabilities, available };
		}
		const detail =
			available.length > 0
				? `Modes that can run here: ${available.join(", ")}`
				: "This environment has no usable interactive UI (neither a custom TUI nor a callable native input dialog)";
		return {
			status: "configured_unavailable",
			configured: mode,
			capabilities,
			available,
			reason: `UI mode "${mode}" was configured explicitly, but this environment cannot run it; ${detail}. No other mode will be used.`,
		};
	}
	if (available.length === 0) {
		return {
			status: "no_available_ui",
			capabilities,
			available: [],
			reason: "This environment has no usable interactive UI: neither a custom TUI nor a callable native input dialog.",
		};
	}
	return { status: "available", route: available[0]!, source: "probed", capabilities, available };
}

export interface CreateAskUserHostOptions {
	/** Human-readable adapter name, used in diagnostics. */
	name: string;
	/** Explicit UI route. When omitted, the route is probed from the implementations below. */
	mode?: AskUserMode;
	customUI?: CustomUIRenderer;
	nativeDialogs?: NativeDialogRunner;
}

/**
 * Build a host adapter, binding only the implementations that were supplied and
 * resolving {@link AskUserHost.support} here — at creation. Nothing is read from
 * the environment and no route is selected again later.
 */
export function createAskUserHost(options: CreateAskUserHostOptions): AskUserHost {
	const host: AskUserHost = {
		name: options.name,
		support: resolveSupport(options.mode, hostCapabilities(options)),
	};
	if (options.customUI) host.customUI = options.customUI;
	if (options.nativeDialogs) host.nativeDialogs = options.nativeDialogs;
	return host;
}

/**
 * Inspect what a host can prompt with, without prompting. Returns the same
 * value resolved at host creation, so callers can decide up front whether a
 * request would be serviced, refused, or impossible — and through which route.
 */
export function askUserSupport(host: AskUserHost): AskUserSupport {
	return host.support;
}
