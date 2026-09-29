/**
 * Example: reuse AskUser from another Pi extension, without going through the
 * model. This runs entirely in-process and never registers a second tool.
 *
 * Load with: pi --extension ./examples/reuse.ts
 *
 * `createAskUser(ctx)` binds the interaction to this host and resolves its route
 * once (an explicit `mode`, else the user config file, else a probe preferring
 * `custom`). The user config at `~/.pi/ask-user/config.json` is read
 * once here and its `displayMode`/`timeoutPerQuestionMs` preferences win over the
 * request. Availability is readable up front — before any UI is shown — so the
 * command can bail out early. A direct call resolves to the caller and never
 * forwards anything to the model; a direct call has no Pi event bus, so pass an
 * `events` sink to observe the wait (see README).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAskUser, TOOL_NAME } from "../src/index.ts";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("release-target", {
		description: `Ask the user where to release, using ${TOOL_NAME}`,
		handler: async (_args, ctx) => {
			const ask = createAskUser(ctx);
			if (!ask.isAvailable) {
				ctx.ui.notify(`No interactive UI: ${ask.notAvailableReason}`, "warning");
				return;
			}

			const result = await ask({
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
			});

			if (result.status === "error") {
				ctx.ui.notify(`AskUser failed (${result.error?.code}): ${result.error?.message}`, "error");
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
