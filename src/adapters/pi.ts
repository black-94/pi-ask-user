import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, matchesKey, type KeyId, type OverlayHandle } from "@earendil-works/pi-tui";
import {
	DEFAULT_OVERLAY_TOGGLE_KEY,
	isAllowedOverlayToggleSpec,
	resolveAskUserConfig,
	toUiPreferences,
	type AskUserConfigOverrides,
} from "../config.ts";
import { createAskUserHost, type CreateAskUserHostOptions } from "../route.ts";
import type {
	AskUIInput,
	AskUIOutcome,
	AskUserDisplayMode,
	AskUserHost,
	AskUserMode,
	CustomUIRenderer,
} from "../types.ts";
import { AskUserComponent, type AskUserTheme, type CustomUIResult } from "../ui/custom.ts";
import { createNativeRunner } from "../ui/native.ts";

export interface PiHostOptions {
	/**
	 * Explicit UI route: `custom` | `native`. The single highest precedence. When
	 * omitted, the route is probed from the implementations this context really
	 * supports, or read from the user config file. An invalid value is reported as
	 * `invalid_config`.
	 */
	mode?: AskUserMode;
	/** Explicit display mode; overrides the config file and the request. */
	displayMode?: AskUserDisplayMode;
	/** Explicit overlay toggle key; `null` disables it. Overrides the config file. */
	overlayToggleKey?: string | null;
	/** Explicit timeout (ms) per question; overrides the config file and the request. */
	timeoutPerQuestionMs?: number;
	/**
	 * Path to the user config file, or `false` to skip reading it. Defaults to
	 * `~/.pi/ask-user/config.json`. There are no environment variables.
	 */
	configFile?: string | false;
}

/**
 * Build the default host adapter for a running Pi extension, from an available
 * `ExtensionContext`.
 *
 * The Pi lifecycle only exposes the context during a tool call / command
 * handler, so the capability probe happens here, at host creation — not at
 * extension registration, which can capture only the explicit options.
 *
 * The user config file is read here too, once per host, and resolved as
 * `explicit option > file > built-in`. An invalid file does not throw: it makes
 * the host unusable (`invalid_config`), so every call is refused actionably and
 * nothing falls back to another route.
 *
 * Both implementations are bound wherever they can really run:
 *
 *  - `customUI`      — only in `tui` mode with a callable `ctx.ui.custom()`.
 *  - `nativeDialogs` — only when `ctx.hasUI` and `ctx.ui.input` is callable,
 *    i.e. native input dialogs shown one question at a time. RPC reports
 *    `hasUI: true`, so a nonresponsive RPC client is *not* pre-judged: the
 *    attempt is made and the shared deadline turns silence into an actionable
 *    `timeout`.
 *
 * The route is then resolved once (explicit `mode`, else the probe with `custom`
 * preferred, else unsupported) and stored on the host. JSON/print have no
 * dialog-capable UI, so with no explicit mode the result is `no_available_ui`,
 * and an explicit `custom`/`native` there is `configured_unavailable` — neither
 * silently becomes a different route. The model can never influence any of this:
 * it comes from this adapter, not from tool parameters.
 */
export function createPiHost(ctx: ExtensionContext, options: PiHostOptions = {}): AskUserHost {
	const programmatic: AskUserConfigOverrides = {};
	if (options.mode !== undefined) programmatic.mode = options.mode;
	if (options.displayMode !== undefined) programmatic.displayMode = options.displayMode;
	if ("overlayToggleKey" in options) programmatic.overlayToggleKey = options.overlayToggleKey;
	if (options.timeoutPerQuestionMs !== undefined) programmatic.timeoutPerQuestionMs = options.timeoutPerQuestionMs;

	const resolved = resolveAskUserConfig(programmatic, { configFile: options.configFile });
	const config = resolved.config;

	const hostOptions: CreateAskUserHostOptions = { name: "pi" };
	if (config.mode !== undefined) hostOptions.mode = config.mode;
	hostOptions.preferences = toUiPreferences(config);
	if (resolved.error !== undefined) hostOptions.configError = resolved.error.message;

	const overlayToggleKey =
		config.overlayToggleKey === undefined ? DEFAULT_OVERLAY_TOGGLE_KEY : config.overlayToggleKey;
	if (ctx.mode === "tui" && typeof ctx.ui?.custom === "function") {
		hostOptions.customUI = createPiCustomRenderer(ctx.ui, { overlayToggleKey });
	}
	if (ctx.hasUI && typeof ctx.ui?.input === "function") {
		hostOptions.nativeDialogs = createNativeRunner(ctx.ui);
	}
	return createAskUserHost(hostOptions);
}

export interface PiCustomRendererOptions {
	/**
	 * The overlay show/hide key, or `null` to disable it. When omitted, the
	 * built-in default (`alt+o`) applies. Ignored on the native route and for
	 * inline display, which register no listener.
	 */
	overlayToggleKey?: string | null;
}

/**
 * Custom renderer backed by `ctx.ui.custom()`. TUI mode only.
 *
 * For an overlay it also installs the show/hide shortcut: the overlay handle
 * (`onHandle` → `OverlayHandle.setHidden`) plus a raw `ctx.ui.onTerminalInput`
 * listener, so the *same* key restores the overlay even while it is hidden
 * (hidden overlays receive no component input). The listener is removed and the
 * handle dropped in `finally`, on every exit path. Hiding neither resolves the
 * interaction nor pauses its deadline: aborts and timeouts still complete while
 * hidden, and `Esc` still cancels.
 */
export function createPiCustomRenderer(ui: ExtensionUIContext, options: PiCustomRendererOptions = {}): CustomUIRenderer {
	const rawToggle = options.overlayToggleKey;
	const candidate = rawToggle === null ? undefined : (rawToggle ?? DEFAULT_OVERLAY_TOGGLE_KEY);
	// Defensive guard: the config layer rejects reserved/conflicting keys with an
	// actionable error, so a validated chord always arrives here. A direct caller
	// that bypasses it gets the toggle disabled rather than a listener that could
	// shadow Esc or steal typing — never a silent substitution of another key.
	const toggleSpec = candidate !== undefined && isAllowedOverlayToggleSpec(candidate) ? candidate : undefined;
	return {
		async render(input: AskUIInput): Promise<AskUIOutcome> {
			const { request, deadline, signal } = input;
			const overlay = request.displayMode !== "inline";
			const toggle = overlay ? toggleSpec : undefined;

			let handle: OverlayHandle | undefined;
			let unsubscribe: (() => void) | undefined;
			let component: AskUserComponent | undefined;
			let abortHandler: (() => void) | undefined;
			let cleanedUp = false;
			let announced = false;

			// Idempotent: safe to call from the abort path, `finally`, and repeatedly.
			const cleanup = (): void => {
				if (cleanedUp) return;
				cleanedUp = true;
				if (abortHandler && signal) {
					signal.removeEventListener("abort", abortHandler);
					abortHandler = undefined;
				}
				unsubscribe?.();
				unsubscribe = undefined;
				handle = undefined;
				component = undefined;
			};
			// On abort/timeout the core settles independently of `ui.custom`; remove
			// the raw listener and drop the handle immediately so keys can no longer
			// be captured even if the custom UI never resolves.
			const onAbort = (): void => {
				try {
					component?.abort();
				} catch {
					// Settling the component must not mask the abort.
				}
				cleanup();
			};

			try {
				if (signal?.aborted) {
					// Already cancelled before any UI: install no side effects.
					onAbort();
					return { kind: "abort" };
				}
				if (signal) {
					abortHandler = onAbort;
					signal.addEventListener("abort", onAbort, { once: true });
				}

				if (toggle !== undefined && typeof ui.onTerminalInput === "function") {
					unsubscribe = ui.onTerminalInput((data) => {
						if (!handle || !matchesKey(data, toggle as KeyId)) return undefined;
						// Kitty's progressive protocol reports press, repeat and release
						// separately. Toggle only on the initial press; consume repeat and
						// release so they cannot reach the component behind the overlay.
						if (isKeyRepeat(data) || isKeyRelease(data)) return { consume: true };
						const nextHidden = !handle.isHidden();
						handle.setHidden(nextHidden);
						if (nextHidden && !announced) {
							announced = true;
							ui.notify?.(`ask_user hidden — press ${toggle} to reopen`, "info");
						}
						return { consume: true };
					});
				}

				input.onUpdate?.("Waiting for user input…");
				const result = await ui.custom<CustomUIResult>(
					(tui, theme, _keybindings, done) => {
						component = new AskUserComponent({
							request,
							deadline,
							theme: theme as unknown as AskUserTheme,
							tui,
							done,
							overlayToggleKey: toggle,
						});
						if (signal?.aborted) queueMicrotask(() => component?.abort());
						return component;
					},
					{
						overlay,
						overlayOptions: {
							anchor: "center",
							// Keep the dialog readable on very wide terminals; Pi clamps
							// this fixed width to the available columns on smaller ones.
							width: 96,
							minWidth: 64,
							maxHeight: "85%",
							margin: 1,
						},
						// Only an overlay has a handle to hide/show.
						...(
							overlay
								? {
										onHandle: (overlayHandle: OverlayHandle) => {
											handle = overlayHandle;
										},
									}
								: {}
						),
					},
				);
				if (!result) {
					return { kind: "error", message: "custom UI returned no result (the host failed to render the custom component)." };
				}
				return result;
			} finally {
				cleanup();
			}
		},
	};
}
