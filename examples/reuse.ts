/**
 * Example: reuse AskUserUI from another Pi extension, without going through the
 * model. This runs entirely in-process and never registers a second tool.
 *
 * Load with: pi --extension ./examples/reuse.ts
 *
 * Capabilities are declared by this trusted adapter, not by the model. In TUI
 * mode `createPiHost` declares custom UI. For an RPC/ACP host whose client really
 * answers the dialog sub-protocol, pass native support explicitly:
 *
 *   createPiHost(ctx, { capabilities: { nativeDialogs: true } })
 *
 * Without that, RPC takes the plain-text route.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { askUser, createPiHost, type AskUserResult } from "../src/index.ts";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("release-target", {
		description: "Ask the user where to release, using AskUserUI",
		handler: async (_args, ctx) => {
			const result: AskUserResult = await askUser(
				{
					header: "Release",
					questions: [
						{
							title: "Where should we release?",
							kind: "single",
							options: [
								{ label: "staging", description: "Safe internal target" },
								{ label: "production", description: "Customer-facing" },
							],
						},
						{ title: "Anything to note?", kind: "input" },
					],
				},
				{ host: createPiHost(ctx) },
			);

			if (result.status === "answered") {
				ctx.ui.notify(
					result.answers.map((answer) => `${answer.title}=${answer.selections.join(",") || answer.freeText}`).join(" | "),
					"info",
				);
				return;
			}
			ctx.ui.notify(`No answer (${result.status})`, "warning");
		},
	});
}
