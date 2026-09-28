import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { type AppendixRegistry, createPlainTextHook, defaultAppendixRegistry } from "../output.ts";
import type { AskUIInput, AskUIOutcome, AskUserHost, CustomUIRenderer } from "../types.ts";
import { AskUserComponent, type AskUserTheme, type CustomUIResult } from "../ui/custom.ts";
import { createNativeRunner } from "../ui/native.ts";

/**
 * Explicit capability declaration by a trusted host adapter.
 *
 * Nothing is inferred from `ctx.hasUI`. In particular RPC reports `hasUI: true`
 * because dialog methods exist on the protocol, but that does not mean the
 * connected client actually answers them. A host that knows its client supports
 * the dialog sub-protocol must opt in with `{ nativeDialogs: true }`.
 */
export interface PiCapabilityDeclaration {
	/** Declare the custom terminal UI. Only honoured in `tui` mode. Default: `ctx.mode === "tui"`. */
	customUI?: boolean;
	/** Declare native dialogs. Requires `ctx.hasUI`. Default: `false`. */
	nativeDialogs?: boolean;
}

export interface PiHostOptions {
	/** Registry flushed by the extension's `message_end` hook. Defaults to the shared registry. */
	registry?: AppendixRegistry;
	/** Explicit capability opt-in. Defaults to custom-UI-in-TUI only, no native dialogs. */
	capabilities?: PiCapabilityDeclaration;
}

/** Convenience declaration for RPC/ACP hosts whose client implements the dialog sub-protocol. */
export const PI_NATIVE_DIALOG_CAPABILITIES: PiCapabilityDeclaration = { nativeDialogs: true };

/**
 * Build the default host adapter for a running Pi extension.
 *
 * Capabilities are opt-in and bound to a real implementation:
 *  - `customUI`      defaults to `ctx.mode === "tui"` and is only created in TUI
 *                    mode, where `ctx.ui.custom()` renders a real component.
 *  - `nativeDialogs` defaults to **false**; it is created only when the trusted
 *                    host explicitly opts in *and* `ctx.hasUI`. RPC's `hasUI` is
 *                    not sufficient on its own.
 *  - `plainText`     always, backed by the `message_end` output hook.
 *
 * With no declaration, RPC/ACP take the plain-text route. JSON/print modes
 * declare neither interactive capability and therefore also take plain text.
 * The model can never influence these declarations: they come from this adapter,
 * not from tool parameters.
 */
export function createPiHost(ctx: ExtensionContext, options: PiHostOptions = {}): AskUserHost {
	const registry = options.registry ?? defaultAppendixRegistry;
	const host: AskUserHost = {
		name: "pi",
		plainText: createPlainTextHook(registry),
	};
	const wantsCustomUI = options.capabilities?.customUI ?? ctx.mode === "tui";
	const wantsNativeDialogs = options.capabilities?.nativeDialogs ?? false;

	if (wantsCustomUI && ctx.mode === "tui") {
		host.customUI = createPiCustomRenderer(ctx.ui);
	}
	if (wantsNativeDialogs && ctx.hasUI) {
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
