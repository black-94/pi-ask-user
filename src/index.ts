import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { createPiHost, type PiCapabilityDeclaration } from "./adapters/pi.ts";
import { askUserNormalized } from "./core.ts";
import { AppendixRegistry, createPlainTextHook, defaultAppendixRegistry, flushAppendix } from "./output.ts";
import { AskUserUIParams, normalizeAskUserRequest } from "./schema.ts";
import type { AskUserResult, AskUserRoute, AskUserStatus, NormalizedRequest } from "./types.ts";

// ---------------------------------------------------------------------------
// Re-exports: reusable TS surface for other extensions and MCP bridges
// ---------------------------------------------------------------------------

export * from "./types.ts";
export { askUser, askUserNormalized } from "./core.ts";
export {
	createPiHost,
	createPiCustomRenderer,
	PI_NATIVE_DIALOG_CAPABILITIES,
	type PiCapabilityDeclaration,
	type PiHostOptions,
} from "./adapters/pi.ts";
export {
	ASKUSERUI_MCP_CONTRACT,
	ASKUSERUI_MCP_INPUT_SCHEMA,
	MCP_DELIVERED_PREAMBLE,
	createMCPFinalOutputHook,
	createMCPHost,
	createMCPNativeRunner,
	formatMCPDeliveredResult,
	type MCPElicitationResult,
	type MCPElicitFn,
	type MCPFinalOutputAdapter,
	type MCPHostOptions,
} from "./adapters/mcp.ts";
export { createNativeRunner, type NativeDialogUI } from "./ui/native.ts";
export {
	AskUserComponent,
	MIN_USABLE_ROWS,
	SPLIT_MIN_WIDTH,
	type AskUserTheme,
	type CustomUIResult,
} from "./ui/custom.ts";
export { formatPlainText } from "./plaintext.ts";
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
export { hostCapabilities, pickRoute } from "./route.ts";
export { createDeadline, combineSignals, safeTimeoutMs, MAX_SAFE_TIMEOUT_MS, type LinkedSignal } from "./deadline.ts";
export {
	AppendixRegistry,
	createPlainTextHook,
	createUnavailablePlainTextHook,
	defaultAppendixRegistry,
	flushAppendix,
} from "./output.ts";
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
	route: AskUserRoute;
	status: AskUserStatus;
	answers: AskUserResult["answers"];
	plainText?: string;
	deferred: boolean;
	warnings?: string[];
	error?: AskUserResult["error"];
	/** Present while streaming progress updates. */
	progress?: string;
}

const DESCRIPTION = [
	"Ask the user one or more structured questions through the best UI the current host supports.",
	"Up to 5 questions, each with up to 5 options plus an always-available free-text answer.",
	"Use it when a decision would otherwise require guessing. If no interactive UI is available,",
	"the questions are appended to your reply as plain text for the user to answer next turn.",
].join(" ");

const PROMPT_SNIPPET =
	"Ask the user structured questions (options + free text) when you would otherwise guess; adaptive to custom TUI, native dialogs, or plain text.";

const PROMPT_GUIDELINES = [
	"Use AskUserUI when a choice is high-impact or ambiguous and you cannot infer the answer from the codebase.",
	"Give every option a short label and a one-line description; keep 2-5 options per question.",
	"Provide a `default` when a question is optional; the user can then skip it.",
	"If the tool reports no interactive UI, do not answer the question yourself — end your turn so the user can reply.",
];

function buildModelContent(result: AskUserResult): string {
	switch (result.status) {
		case "answered": {
			const lines = result.answers.map((answer) => {
				const parts: string[] = [];
				if (answer.selections.length > 0) parts.push(answer.selections.join(", "));
				if (answer.freeText) parts.push(answer.freeText);
				const value = parts.length > 0 ? parts.join(" | ") : "(空)";
				const suffix = answer.usedDefault ? "（默认值）" : "";
				return `- ${answer.title}: ${value}${suffix}`;
			});
			return `用户已回答问卷：\n${lines.join("\n")}`;
		}
		case "cancelled":
			return result.cancelledReason === "abort"
				? "询问被中止（abort），没有得到答案。"
				: "用户取消了本次询问，没有得到答案。请勿虚构答案。";
		case "timeout":
			return "询问超时，用户未在限定时间内回答。请勿虚构答案；可稍后重试或说明你采用的保守默认。";
		case "error":
			return `询问失败（${result.error?.code ?? "internal"}）：${result.error?.message ?? "未知错误"}`;
		case "deferred":
			return [
				"当前环境没有交互 UI，无法即时提问。",
				"该问卷已作为纯文本附加在你的最终回复之后。",
				"请不要自行回答问卷，直接简短收尾并结束本回合，等待用户在下一条消息中回复。",
			].join("");
		case "delivered":
			return [
				"当前环境没有交互 UI，也无法在最终回复之后追加内容。",
				"该问卷已作为纯文本随本次工具结果返回给调用方交付给用户。",
				"用户尚未回答，请不要自行回答问卷；等待用户在下一条消息中回复。",
			].join("");
	}
}

export interface RegisterAskUserUIOptions {
	/** Registry used by the plain-text output hook. Defaults to the shared registry. */
	registry?: AppendixRegistry;
	/**
	 * Explicit host capability opt-in (see {@link PiCapabilityDeclaration}).
	 * Defaults to custom-UI-in-TUI only, no native dialogs — so RPC/ACP use the
	 * plain-text route unless the embedder declares native dialog support.
	 */
	capabilities?: PiCapabilityDeclaration;
}

/**
 * Register the `AskUserUI` tool and the `message_end` output hook.
 *
 * The hook is what makes the no-UI route honest: the plain-text questionnaire is
 * appended to the finalized assistant message before control returns to the
 * caller, and never written to stdout directly.
 */
export function registerAskUserUITool(pi: ExtensionAPI, options: RegisterAskUserUIOptions = {}): void {
	const registry = options.registry ?? defaultAppendixRegistry;
	const capabilities = options.capabilities;

	pi.on("message_end", (event) => {
		const next = flushAppendix(event.message as unknown as { role?: unknown; content?: unknown }, registry);
		if (!next) return undefined;
		return { message: next as unknown as typeof event.message };
	});

	// Defensive: a plain-text questionnaire that never found a final assistant
	// message must not leak into a later, unrelated run.
	pi.on("message_start", (event) => {
		const message = event.message as unknown as { role?: unknown };
		if (message.role === "user") registry.clear();
	});
	pi.on("session_shutdown", () => {
		registry.clear();
	});

	pi.registerTool<typeof AskUserUIParams, AskUserUIDetails>({
		name: TOOL_NAME,
		label: "Ask User UI",
		description: DESCRIPTION,
		promptSnippet: PROMPT_SNIPPET,
		promptGuidelines: PROMPT_GUIDELINES,
		executionMode: "sequential",
		parameters: AskUserUIParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx: ExtensionContext) {
			let request: NormalizedRequest;
			let warnings: string[] = [];
			try {
				const normalized = normalizeAskUserRequest(params);
				request = normalized.request;
				warnings = normalized.warnings;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				const details: AskUserUIDetails = {
					route: "plain_text",
					status: "error",
					answers: [],
					deferred: false,
					error: { code: "invalid_request", message },
				};
				return { content: [{ type: "text" as const, text: `参数无效：${message}` }], details };
			}

			const host = createPiHost(ctx, { registry, ...(capabilities ? { capabilities } : {}) });
			const onUpdateText = onUpdate
				? (text: string) =>
						onUpdate({
							content: [{ type: "text" as const, text }],
							details: {
								route: "custom",
								status: "answered",
								answers: [],
								deferred: false,
								progress: text,
							} satisfies AskUserUIDetails,
						})
				: undefined;
			const askOptions: Parameters<typeof askUserNormalized>[1] = { host };
			if (signal) askOptions.signal = signal;
			if (onUpdateText) askOptions.onUpdate = onUpdateText;

			const result = await askUserNormalized(request, askOptions, warnings);

			const details: AskUserUIDetails = {
				route: result.route,
				status: result.status,
				answers: result.answers,
				deferred: result.deferred,
			};
			if (result.plainText !== undefined) details.plainText = result.plainText;
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
			const label = `AskUserUI · ${count} 个问题`;
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
				return new Text(theme.fg("muted", text || "等待用户输入…"), 0, 0);
			}
			const status = details?.status ?? "error";
			const tone =
				status === "answered" || status === "deferred" || status === "delivered"
					? "success"
					: status === "error"
						? "error"
						: "warning";
			const header = theme.fg(tone, `AskUserUI: ${status} (${details?.route ?? "?"})`);
			return new Text(`${header}\n${theme.fg("toolOutput", text)}`, 0, 0);
		},
	});
}

/** Pi extension entry point. */
export default function registerAskUserUI(pi: ExtensionAPI): void {
	registerAskUserUITool(pi);
}
