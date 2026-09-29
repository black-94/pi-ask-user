import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { UI_MODE_ENV_VAR, resolveUIMode } from "../mode.ts";
import { type AppendixRegistry, createPlainTextHook, defaultAppendixRegistry } from "../output.ts";
import type { AskUIInput, AskUIOutcome, AskUserHost, AskUserUIMode, CustomUIRenderer } from "../types.ts";
import { AskUserComponent, type AskUserTheme, type CustomUIResult } from "../ui/custom.ts";
import { createNativeRunner } from "../ui/native.ts";

export interface PiHostOptions {
	/** Registry flushed by the extension's `message_end` hook. Defaults to the shared registry. */
	registry?: AppendixRegistry;
	/**
	 * Forced UI route: `custom` | `native` | `text`. Highest precedence — it
	 * overrides {@link UI_MODE_ENV_VAR}. Invalid values are reported as
	 * `invalid_config`, never silently replaced.
	 */
	mode?: AskUserUIMode;
	/**
	 * Environment source for the mode variable, read only by this trusted
	 * adapter. Defaults to `process.env`; tests can inject a value.
	 */
	env?: Record<string, string | undefined>;
}

/**
 * Build the default host adapter for a running Pi extension.
 *
 * The route is **forced**, never detected. The mode is resolved here —
 * `options.mode` > `PI_ASK_USER_UI_MODE` > `native` — and the implementations
 * are bound **independently of the selected route**, wherever they can really
 * run. This is what makes a per-call `askUser(request, { host, mode })` override
 * work: the implementations exist whether or not the adapter's own mode uses
 * them, while a forced route with no bound implementation still fails loudly:
 *
 *  - `customUI`      — bound only in `tui` mode with a callable `ctx.ui.custom()`
 *    (a real Pi TUI component). Forced anywhere else, the core reports
 *    `unsupported_mode`.
 *  - `nativeDialogs` — bound only when `ctx.hasUI` and `ctx.ui.input` is
 *    callable, i.e. one native input dialog per question. RPC reports
 *    `hasUI: true`, so a nonresponsive RPC client is *not* pre-judged as
 *    unsupported: the attempt is made and the shared deadline turns silence into
 *    an actionable `timeout`.
 *  - `plainText`     — always, backed by the `message_end` output hook.
 *
 * JSON/print modes have no dialog-capable UI, so the default (`native`) is
 * unsupported there and fails loudly instead of falling back to text. The model
 * can never influence any of this: it comes from this adapter, not from tool
 * parameters. An invalid `mode`/environment value is recorded as
 * {@link AskUserHost.configError}; a call that supplies its own `mode` overrides
 * it, one without gets the `invalid_config` error.
 */
export function createPiHost(ctx: ExtensionContext, options: PiHostOptions = {}): AskUserHost {
	const registry = options.registry ?? defaultAppendixRegistry;
	const env = options.env ?? process.env;
	const host: AskUserHost = {
		name: "pi",
		plainText: createPlainTextHook(registry),
	};
	const resolved = resolveUIMode(options.mode, env[UI_MODE_ENV_VAR]);
	if (!resolved.ok) {
		host.configError = { code: "invalid_config", message: resolved.message };
	} else {
		host.mode = resolved.mode;
	}

	// Bind wherever the implementation can really run — not only for the mode
	// selected above — so a per-call mode override has something to run.
	if (ctx.mode === "tui" && typeof ctx.ui?.custom === "function") {
		host.customUI = createPiCustomRenderer(ctx.ui);
	}
	if (ctx.hasUI && typeof ctx.ui?.input === "function") {
		host.nativeDialogs = createNativeRunner(ctx.ui);
	}
	return host;
}

/** Custom renderer backed by `ctx.ui.custom()`. TUI mode only. */
export function createPiCustomRenderer(ui: ExtensionUIContext): CustomUIRenderer {
	return {
		async render(input: AskUIInput): Promise<AskUIOutcome> {
			input.onUpdate?.("等待用户输入…");
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
				return { kind: "error", message: "custom UI 未返回结果（宿主未能渲染自定义组件）。" };
			}
			return result;
		},
	};
}
