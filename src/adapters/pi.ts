import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createAskUserHost, type CreateAskUserHostOptions } from "../route.ts";
import type { AskUIInput, AskUIOutcome, AskUserHost, AskUserUIMode, CustomUIRenderer } from "../types.ts";
import { AskUserComponent, type AskUserTheme, type CustomUIResult } from "../ui/custom.ts";
import { createNativeRunner } from "../ui/native.ts";

export interface PiHostOptions {
	/**
	 * Explicit UI route: `custom` | `native`. The single highest precedence. When
	 * omitted, the route is probed from the implementations this context really
	 * supports. An invalid value is reported as `invalid_config`.
	 */
	mode?: AskUserUIMode;
}

/**
 * Build the default host adapter for a running Pi extension, from an available
 * `ExtensionContext`.
 *
 * The Pi lifecycle only exposes the context during a tool call / command
 * handler, so the capability probe happens here, at host creation — not at
 * extension registration, which can capture only the explicit `mode`.
 *
 * Both implementations are bound wherever they can really run:
 *
 *  - `customUI`      — only in `tui` mode with a callable `ctx.ui.custom()`.
 *  - `nativeDialogs` — only when `ctx.hasUI` and `ctx.ui.input` is callable, i.e.
 *    one native input dialog per question. RPC reports `hasUI: true`, so a
 *    nonresponsive RPC client is *not* pre-judged: the attempt is made and the
 *    shared deadline turns silence into an actionable `timeout`.
 *
 * The route is then resolved once (explicit `mode`, else the probe with `custom`
 * preferred, else unsupported) and stored on the host. JSON/print have no
 * dialog-capable UI, so with no explicit mode the result is `no_available_ui`,
 * and an explicit `custom`/`native` there is `configured_unavailable` — neither
 * silently becomes a different route. The model can never influence any of this:
 * it comes from this adapter, not from tool parameters.
 */
export function createPiHost(ctx: ExtensionContext, options: PiHostOptions = {}): AskUserHost {
	const hostOptions: CreateAskUserHostOptions = { name: "pi" };
	if (options.mode !== undefined) hostOptions.mode = options.mode;
	if (ctx.mode === "tui" && typeof ctx.ui?.custom === "function") {
		hostOptions.customUI = createPiCustomRenderer(ctx.ui);
	}
	if (ctx.hasUI && typeof ctx.ui?.input === "function") {
		hostOptions.nativeDialogs = createNativeRunner(ctx.ui);
	}
	return createAskUserHost(hostOptions);
}

/** Custom renderer backed by `ctx.ui.custom()`. TUI mode only. */
export function createPiCustomRenderer(ui: ExtensionUIContext): CustomUIRenderer {
	return {
		async render(input: AskUIInput): Promise<AskUIOutcome> {
			input.onUpdate?.("Waiting for user input…");
			const { request, deadline, signal } = input;
			const result = await ui.custom<CustomUIResult>(
				(tui, theme, _keybindings, done) => {
					const component = new AskUserComponent({
						request,
						deadline,
						theme: theme as unknown as AskUserTheme,
						tui,
						done,
					});
					if (signal) {
						if (signal.aborted) {
							queueMicrotask(() => component.abort());
						} else {
							signal.addEventListener("abort", () => component.abort(), { once: true });
						}
					}
					return component;
				},
				{
					overlay: request.displayMode !== "inline",
					overlayOptions: {
						anchor: "center",
						width: "92%",
						minWidth: 40,
						maxHeight: "85%",
						margin: 1,
					},
				},
			);
			if (!result) {
				return { kind: "error", message: "custom UI returned no result (the host failed to render the custom component)." };
			}
			return result;
		},
	};
}
