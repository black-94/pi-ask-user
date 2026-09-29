/**
 * Example: reuse AskUserUI from another Pi extension, without going through the
 * model. This runs entirely in-process and never registers a second tool.
 *
 * Load with: pi --extension ./examples/reuse.ts
 *
 * The route is forced by configuration, never detected: `createPiHost` resolves
 * `custom` | `native` | `text` from the programmatic option, then from
 * `PI_ASK_USER_UI_MODE`, then from the default `native`. The model cannot change
 * it — there is no route field in the tool parameters.
 *
 * Force a route explicitly when you know what this command needs:
 *
 *   createPiHost(ctx, { mode: "text" })    // never block: queue/deliver as text
 *   createPiHost(ctx, { mode: "custom" })  // a real Pi TUI only
 *   askUser(request, { host: createPiHost(ctx), mode: "text" })
 *
 * The per-call `mode` is the highest precedence: it overrides the adapter's own
 * configuration and even an invalid `PI_ASK_USER_UI_MODE`, and it works because
 * `createPiHost` binds the implementations wherever they can really run,
 * independently of the configured route. A forced route with no bound
 * implementation (or an invalid value) is an actionable error, never a fallback.
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

			// A forced route the environment cannot run is an actionable error,
			// never a silent fallback — surface it instead of guessing.
			if (result.status === "error") {
				ctx.ui.notify(`AskUserUI 失败（${result.error?.code}）：${result.error?.message}`, "error");
				return;
			}

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
