import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { createPiHost } from "./adapters/pi.ts";
import { createAskEventSink } from "./events.ts";
import { askUserNormalized } from "./core.ts";
import { AskUserParams, normalizeAskUserRequest } from "./schema.ts";
import type {
	AskUserDisplayMode,
	AskUserErrorCode,
	AskUserHost,
	AskUserMode,
	AskUserResult,
	AskUserRoute,
	AskUserStatus,
	NormalizedRequest,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Re-exports: reusable TypeScript surface for other extensions
// ---------------------------------------------------------------------------

export * from "./types.ts";
export { askUser, askUserNormalized } from "./core.ts";
export { createPiHost, createPiCustomRenderer, type PiHostOptions } from "./adapters/pi.ts";
export { createAskUser, type AskUser, type CreateAskUserOptions } from "./ask.ts";
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
	AskUserParams,
	DEFAULT_TIMEOUT_PER_QUESTION_MS,
	LIMITS,
	MAX_OPTIONS,
	MAX_QUESTIONS,
	normalizeAskUserRequest,
} from "./schema.ts";
export { hostCapabilities, probeRoutes, createAskUserHost, askUserSupport, type CreateAskUserHostOptions } from "./route.ts";
export { UI_MODES, isUIMode } from "./mode.ts";
export {
	AskUserConfigError,
	DEFAULT_DISPLAY_MODE,
	DEFAULT_OVERLAY_TOGGLE_KEY,
	USER_CONFIG_DIR,
	USER_CONFIG_PATH,
	isAllowedOverlayToggleSpec,
	normalizeOverlayToggleKey,
	parseAskUserConfig,
	parseAskUserOptions,
	readAskUserConfigFile,
	resolveAskUserConfig,
	toUiPreferences,
	type AskUserConfigOverrides,
	type ResolvedAskUserConfig,
} from "./config.ts";
export {
	ASK_ABORTED,
	ASK_ANSWERED,
	ASK_ERROR,
	ASK_TIMEOUT,
	HERDR_BLOCKED,
	WAITING_LABEL,
	createAskEventSink,
	outcomeChannel,
	type AskEventBus,
} from "./events.ts";
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

export const TOOL_NAME = "ask_user";

export interface AskUserToolDetails {
	/** Absent when no route ran (invalid_request / invalid_config). */
	route?: AskUserRoute;
	status: AskUserStatus;
	answers: AskUserResult["answers"];
	warnings?: string[];
	error?: AskUserResult["error"];
	/** Present while streaming progress updates. */
	progress?: string;
}

const DESCRIPTION = "Ask the user one or more structured questions through the host's interactive UI.";

const PROMPT_SNIPPET = "Ask the user structured questions when you would otherwise guess.";

const PROMPT_GUIDELINES = [
	"Use ask_user when a choice is high-impact or ambiguous and you cannot infer the answer.",
	"If the tool reports the UI could not run, ask the user the question yourself in ordinary text instead.",
	"Never invent an answer; on aborted or timeout, report it plainly and do not re-ask.",
];

/**
 * Error codes that mean the interactive UI could not be shown or run. For these
 * the tool text advises the model to ask the user in ordinary text instead. An
 * invalid questionnaire or an empty answer is *not* a UI failure.
 */
const UI_FAILURE_CODES: readonly AskUserErrorCode[] = [
	"unsupported_mode",
	"invalid_config",
	"not_initialized",
	"custom_ui_failed",
	"native_ui_failed",
];

function isUIFailure(code: AskUserErrorCode | undefined): boolean {
	return code !== undefined && UI_FAILURE_CODES.includes(code);
}

/** Render the questionnaire as plain text, used only in the fallback advice. */
function describeRequestAsText(request: NormalizedRequest): string {
	const lines: string[] = [];
	if (request.header && request.header.trim() !== "") lines.push(request.header.trim());
	request.questions.forEach((question, index) => {
		const prompt = question.prompt?.trim();
		lines.push(`${index + 1}. ${question.title}${prompt ? ` — ${prompt}` : ""}`);
		question.options.forEach((option, optionIndex) => {
			const description = option.description?.trim();
			lines.push(`   ${optionIndex + 1}) ${option.label}${description ? ` — ${description}` : ""}`);
		});
		if (question.hasDefault && question.default !== undefined) lines.push(`   default: ${question.default}`);
	});
	return lines.join("\n");
}

/**
 * Model-facing text for a tool result. UI-unavailable/display failures carry an
 * explicit ordinary-text fallback (with the question content); timeouts and
 * aborts do not, because the UI may already have been shown and re-asking would
 * prompt the user twice. In every case the model is told not to invent an answer.
 */
function buildModelContent(result: AskUserResult, request: NormalizedRequest): string {
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
			return `The user answered:\n${lines.join("\n")}`;
		}
		case "aborted":
			return result.cancelledReason === "abort"
				? "The request was aborted before an answer. Do not invent one."
				: "The user dismissed the interaction; no answer. Do not invent one or re-ask the same question.";
		case "timeout":
			return "No answer before the deadline. Do not invent one, and do not repeat the same prompt.";
		case "error": {
			const code = result.error?.code;
			const base = `AskUser failed (${code ?? "internal"}): ${result.error?.message ?? "unknown error"}.`;
			if (isUIFailure(code)) {
				return [
					base,
					"The interactive UI could not complete the request. Ask the user the question yourself in ordinary text — this is a fallback message, not an answer:",
					describeRequestAsText(request),
					"Then wait for the user's reply; do not invent an answer.",
				].join("\n");
			}
			if (code === "invalid_request") {
				return `${base} Fix the request and retry the tool call. Do not invent an answer.`;
			}
			// Non-UI failures (empty_answer, internal): report plainly, no retry advice.
			return `${base} Do not invent an answer; report the failure to the user.`;
		}
	}
}

function detailsOf(result: AskUserResult): AskUserToolDetails {
	const details: AskUserToolDetails = { status: result.status, answers: result.answers };
	if (result.route !== undefined) details.route = result.route;
	if (result.warnings !== undefined) details.warnings = result.warnings;
	if (result.error !== undefined) details.error = result.error;
	return details;
}

export interface RegisterAskUserOptions {
	/**
	 * Explicit UI route for this registration: `custom` | `native`. It has the
	 * highest precedence. When omitted, the route is read from the user config
	 * file, else probed from the implementations the context supports (preferring
	 * `custom`), at host creation — never per request. An invalid value, or a
	 * route the environment cannot run, is an actionable error — never a fallback.
	 */
	mode?: AskUserMode;
	/** Explicit display mode; overrides the config file and the model's request. */
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
 * Register the `ask_user` tool for the current extension runtime.
 *
 * The explicit options are captured here, at registration. The host is created
 * once per session from the context delivered to `pi.on("session_start", ...)`,
 * so the capability probe and the user config read run exactly once and every
 * tool call reuses that host. The host is released on `session_shutdown`, which
 * Pi also fires before a reload or session replacement, so the following
 * `session_start` builds a fresh host (and re-reads the config) from the new
 * context.
 *
 * Runtime events: when the tool really enters the interactive wait it emits
 * `herdr:blocked` `{ active: true, ... }`, then exactly one matching
 * `{ active: false, ... }`, plus one outcome event (`ask:answered`,
 * `ask:aborted`, `ask:timeout`, or `ask:error`) carrying the call id and the
 * route/status. Invalid or unavailable requests emit nothing. See `events.ts`.
 *
 * A route the environment cannot run, or a renderer that fails, is reported as
 * an actionable error in the tool text (never a silent fallback and never an
 * unanswered questionnaire handed back as if it were the user's answer).
 */
export function registerAskUser(pi: ExtensionAPI, options: RegisterAskUserOptions = {}): void {
	let host: AskUserHost | undefined;

	pi.on("session_start", (_event, ctx) => {
		host = createPiHost(ctx, options);
	});
	pi.on("session_shutdown", () => {
		host = undefined;
	});

	pi.registerTool<typeof AskUserParams, AskUserToolDetails>({
		name: TOOL_NAME,
		label: "Ask User",
		description: DESCRIPTION,
		promptSnippet: PROMPT_SNIPPET,
		promptGuidelines: PROMPT_GUIDELINES,
		executionMode: "sequential",
		parameters: AskUserParams,
		async execute(toolCallId, params, signal, onUpdate, _ctx: ExtensionContext) {
			let request: NormalizedRequest;
			let warnings: string[] = [];
			try {
				const normalized = normalizeAskUserRequest(params);
				request = normalized.request;
				warnings = normalized.warnings;
			} catch (error) {
				// An invalid questionnaire is a request error, not a UI failure: no
				// ordinary-text fallback is offered here.
				const message = error instanceof Error ? error.message : String(error);
				const details: AskUserToolDetails = {
					status: "error",
					answers: [],
					error: { code: "invalid_request", message },
				};
				return {
					content: [
						{
							type: "text" as const,
							text: `Invalid parameters: ${message} Fix the request and retry the tool call. Do not invent an answer.`,
						},
					],
					details,
				};
			}

			// The session-scoped host is the single source of truth for the route;
			// no probe happens per call. A call before the session has started is an
			// explicit error, not a fabricated "no UI" result.
			const activeHost = host;
			if (!activeHost) {
				const result: AskUserResult = {
					status: "error",
					answers: [],
					error: {
						code: "not_initialized",
						message: "AskUser has not finished session initialization (no session_start received).",
					},
				};
				return { content: [{ type: "text" as const, text: buildModelContent(result, request) }], details: detailsOf(result) };
			}

			// Progress updates advertise the route actually in use; a host that
			// cannot prompt has no route to advertise.
			const onUpdateText = onUpdate
				? (text: string) => {
						const details: AskUserToolDetails = { status: "answered", answers: [], progress: text };
						if (activeHost.support.status === "available") details.route = activeHost.support.route;
						onUpdate({ content: [{ type: "text" as const, text }], details });
					}
				: undefined;
			const askOptions: Parameters<typeof askUserNormalized>[1] = { host: activeHost };
			if (signal) askOptions.signal = signal;
			if (onUpdateText) askOptions.onUpdate = onUpdateText;
			// The event sink is created per call so its correlation id is the tool
			// call id. It is absent when the runtime exposes no usable event bus, in
			// which case nothing is emitted rather than faking a bus.
			const events = createAskEventSink(pi.events, toolCallId);
			if (events) askOptions.events = events;

			const result = await askUserNormalized(request, askOptions, warnings);

			return {
				content: [{ type: "text" as const, text: buildModelContent(result, request) }],
				details: detailsOf(result),
			};
		},
		renderCall(args, theme) {
			const count = Array.isArray(args.questions) ? args.questions.length : 0;
			const titles = Array.isArray(args.questions)
				? args.questions
						.map((question) => (question as { title?: unknown }).title)
						.filter((title): title is string => typeof title === "string")
						.join(" / ")
				: "";
			const label = `${TOOL_NAME} · ${count} question(s)`;
			return new Text(theme.fg("toolTitle", label) + (titles ? theme.fg("muted", ` — ${titles}`) : ""), 0, 0);
		},
		renderResult(result, renderOptions, theme) {
			const details = result.details as AskUserToolDetails | undefined;
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
			const header = theme.fg(tone, `${TOOL_NAME}: ${status} (${details?.route ?? "?"})`);
			return new Text(`${header}\n${theme.fg("toolOutput", text)}`, 0, 0);
		},
	});
}

/** Pi extension entry point. */
export default function askUserExtension(pi: ExtensionAPI): void {
	registerAskUser(pi);
}
