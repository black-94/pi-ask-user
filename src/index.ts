import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { createPiHost, type PiHostOptions } from "./adapters/pi.ts";
import { askUserNormalized } from "./core.ts";
import { AskUserUIParams, normalizeAskUserRequest } from "./schema.ts";
import type {
	AskUserHost,
	AskUserResult,
	AskUserRoute,
	AskUserStatus,
	AskUserUIMode,
	NormalizedRequest,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Re-exports: reusable TS surface for other extensions
// ---------------------------------------------------------------------------

export * from "./types.ts";
export { askUser, askUserNormalized } from "./core.ts";
export {
	createPiHost,
	createPiCustomRenderer,
	type PiHostOptions,
} from "./adapters/pi.ts";
export { createNativeRunner, type NativeDialogUI } from "./ui/native.ts";
export {
	AskUserComponent,
	MIN_USABLE_ROWS,
	SPLIT_MIN_WIDTH,
	type AskUserTheme,
	type CustomUIResult,
} from "./ui/custom.ts";
export { nativeInputHint, parseNativeAnswer, type ParsedAnswer, type ParseOutcome } from "./parse.ts";
export {
	AskUserValidationError,
	AskUserUIParams,
	DEFAULT_TIMEOUT_PER_QUESTION_MS,
	LIMITS,
	MAX_OPTIONS,
	MAX_QUESTIONS,
	normalizeAskUserRequest,
} from "./schema.ts";
export { hostCapabilities, probeRoutes, createAskUserHost, askUserSupport, type CreateAskUserHostOptions } from "./route.ts";
export { UI_MODES, isUIMode } from "./mode.ts";
export { createDeadline, combineSignals, safeTimeoutMs, MAX_SAFE_TIMEOUT_MS, type LinkedSignal } from "./deadline.ts";
export {
	draftFromDefault,
	draftIsEmpty,
	emptyDraft,
	finalizeAnswers,
	toAnswer,
	type DraftAnswer,
	type FinalizeResult,
} from "./answers.ts";

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const TOOL_NAME = "AskUserUI";

export interface AskUserUIDetails {
	/** Absent when no route ran (invalid_request / invalid_config). */
	route?: AskUserRoute;
	status: AskUserStatus;
	answers: AskUserResult["answers"];
	warnings?: string[];
	error?: AskUserResult["error"];
	/** Present while streaming progress updates. */
	progress?: string;
}

const DESCRIPTION = [
	"Ask the user one or more structured questions.",
	"Up to 5 questions, each with up to 5 options plus an always-available free-text answer.",
	"Use it when a decision would otherwise require guessing.",
].join(" ");

const PROMPT_SNIPPET =
	"Ask the user structured questions (options + free text) when you would otherwise guess.";

const PROMPT_GUIDELINES = [
	"Use AskUserUI when a choice is high-impact or ambiguous and you cannot infer the answer from the codebase.",
	"Give every option a short label and a one-line description; keep 2-5 options per question.",
	"Provide a `default` when a question is optional; the user can then skip it.",
	"If the tool reports no interactive UI (unsupported_mode), do not answer the question yourself: tell the user that this host cannot display the configured UI and suggest retrying in a host that supports it. Do not treat an un-interacted questionnaire or a later ordinary reply as the user's answer.",
];

function buildModelContent(result: AskUserResult): string {
	switch (result.status) {
		case "answered": {
			const lines = result.answers.map((answer) => {
				const parts: string[] = [];
				if (answer.selections.length > 0) parts.push(answer.selections.join(", "));
				if (answer.freeText) parts.push(answer.freeText);
				const value = parts.length > 0 ? parts.join(" | ") : "(empty)";
				const suffix = answer.usedDefault ? " (default)" : "";
				return `- ${answer.title}: ${value}${suffix}`;
			});
			return `The user answered the questionnaire:\n${lines.join("\n")}`;
		}
		case "aborted":
			return result.cancelledReason === "abort"
				? "The request was aborted; no answer was given."
				: "The user cancelled this request; no answer was given. Do not invent an answer.";
		case "timeout":
			return "The request timed out; the user did not answer within the deadline. Do not invent an answer; you may retry later or state the conservative default you assumed.";
		case "error":
			return [
				`Request failed (${result.error?.code ?? "internal"}): ${result.error?.message ?? "unknown error"}`,
				" Do not answer the questionnaire yourself; explain the failure to the user and wait for manual handling or a later call.",
			].join("");
	}
}

export interface RegisterAskUserUIOptions {
	/**
	 * Explicit UI route for this registration: `custom` | `native`. It has the
	 * highest precedence. When omitted, the route is probed from the
	 * implementations the context supports (preferring `custom`), at host
	 * creation — never per request. An invalid value, or a route the environment
	 * cannot run, is an actionable error — never a fallback.
	 */
	mode?: AskUserUIMode;
}

/**
 * Register the `AskUserUI` tool for the current extension runtime.
 *
 * The explicit `mode` is captured here, at registration. The host is created
 * once per session from the context delivered to `pi.on("session_start", ...)`
 * — the documented point for long-lived, session-scoped resources — so the
 * capability probe runs exactly once and every tool call reuses that host. The
 * host is released on `session_shutdown`, which Pi also fires before a reload or
 * session replacement, so the following `session_start` builds a fresh host from
 * the new context.
 *
 * The tool sends the model's questionnaire through the resolved route and
 * returns the user's answer; a route the environment cannot run is reported as
 * an actionable `unsupported_mode`, never as an unanswered questionnaire handed
 * back as if it were the user's answer.
 */
export function registerAskUserUITool(pi: ExtensionAPI, options: RegisterAskUserUIOptions = {}): void {
	const mode = options.mode;
	let host: AskUserHost | undefined;

	pi.on("session_start", (_event, ctx) => {
		const hostOptions: PiHostOptions = {};
		if (mode !== undefined) hostOptions.mode = mode;
		host = createPiHost(ctx, hostOptions);
	});
	pi.on("session_shutdown", () => {
		host = undefined;
	});

	pi.registerTool<typeof AskUserUIParams, AskUserUIDetails>({
		name: TOOL_NAME,
		label: "Ask User UI",
		description: DESCRIPTION,
		promptSnippet: PROMPT_SNIPPET,
		promptGuidelines: PROMPT_GUIDELINES,
		executionMode: "sequential",
		parameters: AskUserUIParams,
		async execute(_toolCallId, params, signal, onUpdate, _ctx: ExtensionContext) {
			let request: NormalizedRequest;
			let warnings: string[] = [];
			try {
				const normalized = normalizeAskUserRequest(params);
				request = normalized.request;
				warnings = normalized.warnings;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const details: AskUserUIDetails = {
					status: "error",
					answers: [],
					error: { code: "invalid_request", message },
				};
				return { content: [{ type: "text" as const, text: `Invalid parameters: ${message}` }], details };
			}

			// The session-scoped host is the single source of truth for the route;
			// no probe happens per call. A call before the session has started is an
			// explicit error, not a fabricated "no UI" result.
			const activeHost = host;
			if (!activeHost) {
				const message = "AskUserUI has not finished session initialization (no session_start received); retry once the session is ready.";
				const details: AskUserUIDetails = {
					status: "error",
					answers: [],
					error: { code: "not_initialized", message },
				};
				return { content: [{ type: "text" as const, text: message }], details };
			}

			// Progress updates advertise the route actually in use; a host that
			// cannot prompt has no route to advertise.
			const onUpdateText = onUpdate
				? (text: string) => {
						const details: AskUserUIDetails = { status: "answered", answers: [], progress: text };
						if (activeHost.support.status === "available") details.route = activeHost.support.route;
						onUpdate({ content: [{ type: "text" as const, text }], details });
					}
				: undefined;
			const askOptions: Parameters<typeof askUserNormalized>[1] = { host: activeHost };
			if (signal) askOptions.signal = signal;
			if (onUpdateText) askOptions.onUpdate = onUpdateText;

			const result = await askUserNormalized(request, askOptions, warnings);

			const details: AskUserUIDetails = {
				route: result.route,
				status: result.status,
				answers: result.answers,
			};
			if (result.warnings !== undefined) details.warnings = result.warnings;
			if (result.error !== undefined) details.error = result.error;

			return { content: [{ type: "text" as const, text: buildModelContent(result) }], details };
		},
		renderCall(args, theme) {
			const count = Array.isArray(args.questions) ? args.questions.length : 0;
			const titles = Array.isArray(args.questions)
				? args.questions
						.map((question) => (question as { title?: unknown }).title)
						.filter((title): title is string => typeof title === "string")
						.join(" / ")
				: "";
			const label = `AskUserUI · ${count} question(s)`;
			return new Text(theme.fg("toolTitle", label) + (titles ? theme.fg("muted", ` — ${titles}`) : ""), 0, 0);
		},
		renderResult(result, renderOptions, theme) {
			const details = result.details as AskUserUIDetails | undefined;
			const text =
				result.content
					.filter((block) => block.type === "text")
					.map((block) => (block as { text?: string }).text ?? "")
					.join("\n") || "";
			if (renderOptions.isPartial) {
				return new Text(theme.fg("muted", text || "Waiting for user input…"), 0, 0);
			}
			const status = details?.status ?? "error";
			const tone = status === "answered" ? "success" : status === "error" ? "error" : "warning";
			const header = theme.fg(tone, `AskUserUI: ${status} (${details?.route ?? "?"})`);
			return new Text(`${header}\n${theme.fg("toolOutput", text)}`, 0, 0);
		},
	});
}

/** Pi extension entry point. */
export default function registerAskUserUI(pi: ExtensionAPI): void {
	registerAskUserUITool(pi);
}
