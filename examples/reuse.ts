/**
 * Example: reuse AskUserUI from another Pi extension, without going through the
 * model. This runs entirely in-process and never registers a second tool.
 *
 * Load with: pi --extension ./examples/reuse.ts
 *
 * The route is resolved once, when the host is created: an explicit `mode`
 * wins, otherwise `createPiHost` probes what the context really supports
 * (`custom` when both can run, otherwise the one that can). The model cannot
 * change it — there is no route field in the tool parameters.
 *
 * Set a route explicitly when you know what this command needs:
 *
 *   createPiHost(ctx, { mode: "custom" })  // a real Pi TUI only
 *
 * If the configured route cannot run here it is refused as an actionable error,
 * never replaced by the probed route. You can inspect the outcome up front with
 * `askUserSupport(createPiHost(ctx))` without prompting.
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
				ctx.ui.notify(`AskUserUI failed (${result.error?.code}): ${result.error?.message}`, "error");
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
