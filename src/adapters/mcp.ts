import { draftFromDefault, toAnswer } from "../answers.ts";
import { UI_MODE_ENV_VAR, resolveUIMode } from "../mode.ts";
import { nativeInputHint, parseNativeAnswer } from "../parse.ts";
import { AskUserUIParams } from "../schema.ts";
import {
	AppendixRegistry,
	createPlainTextHook,
	createUnavailablePlainTextHook,
	flushAppendix,
} from "../output.ts";
import type {
	AskUIInput,
	AskUIOutcome,
	AskUserAnswer,
	AskUserHost,
	AskUserResult,
	AskUserUIMode,
	NativeDialogRunner,
	NormalizedQuestion,
	PlainTextOutputHook,
} from "../types.ts";

/**
 * MCP bridge contract.
 *
 * An MCP host cannot render Pi's TUI, so `customUI` is never bound (forcing
 * `custom` is `unsupported_mode`). The two runnable routes are:
 *  - `native`: one question per elicitation request (same parsing/validation as
 *    the Pi native route). Requires a client that supports elicitation; this is
 *    the unconfigured **default** mode, like every other adapter.
 *  - `text`: return the formatted questionnaire **directly in the tool result**.
 *    This is the normal outcome of the route — not an error. `askUser` reports
 *    `status: "delivered"`, `deferred: false`, with `plainText` populated. A
 *    bridge serving a client without elicitation must opt in explicitly with
 *    `createMCPHost({ mode: "text" })`; with the default `native` and no
 *    elicitation the call fails with `unsupported_mode` instead of silently
 *    downgrading.
 *
 * A generic MCP client has no final-response hook, so the questionnaire cannot be
 * appended after the assistant's final answer from here. That is fine: the bridge
 * puts `plainText` in the tool result, the user replies with an ordinary message
 * on the next turn, and nothing claims the question was answered.
 *
 * If the bridge *does* own a hook on the final assistant message, it can build
 * one with {@link createMCPFinalOutputHook}; then `askUser` reports
 * `status: "deferred"`, `deferred: true`, and the questionnaire is appended after
 * the final answer instead.
 */

/** Minimal subset of an MCP elicitation result the bridge reads. */
export interface MCPElicitationResult {
	action: "accept" | "decline" | "cancel";
	content?: Record<string, unknown>;
}

export type MCPElicitFn = (request: {
	message: string;
	requestedSchema: Record<string, unknown>;
	/** Remaining time for this questionnaire, when the transport can use it. */
	timeoutMs?: number;
	/** Aborts when the questionnaire deadline expires or the caller cancels. */
	signal?: AbortSignal;
}) => Promise<MCPElicitationResult>;

export interface MCPHostOptions {
	/** Adapter name used in diagnostics. Defaults to `mcp`. */
	name?: string;
	/** Elicitation call. Its presence is what makes the `native` route runnable. */
	elicit?: MCPElicitFn;
	/** Output hook. Defaults to an unavailable hook so the bridge must deliver `plainText`. */
	plainTextHook?: PlainTextOutputHook;
	/**
	 * Forced route: `custom` | `native` | `text`. Programmatic, highest
	 * precedence — it overrides {@link UI_MODE_ENV_VAR}. Invalid values are
	 * recorded as `configError`, never silently replaced.
	 */
	mode?: AskUserUIMode;
	/**
	 * Environment source for the mode variable, read only by this trusted
	 * adapter. Defaults to `process.env`; tests can inject a value.
	 */
	env?: Record<string, string | undefined>;
}

/**
 * Create an AskUserUI host adapter for an MCP bridge.
 *
 * The default mode is `native` — the same unconfigured default as every other
 * adapter, with no capability inference and no silent fallback. A bridge whose
 * client does not support elicitation therefore fails with `unsupported_mode`
 * until it explicitly opts into `createMCPHost({ mode: "text" })`. The native
 * runner is bound whenever an elicitation call is supplied, independently of
 * the selected route, so a per-call `askUser(request, { host, mode })` override
 * has something to run.
 */
export function createMCPHost(options: MCPHostOptions = {}): AskUserHost {
	const env = options.env ?? process.env;
	const host: AskUserHost = {
		name: options.name ?? "mcp",
		plainText: options.plainTextHook ?? createUnavailablePlainTextHook(),
	};
	const resolved = resolveUIMode(options.mode, env[UI_MODE_ENV_VAR]);
	if (!resolved.ok) {
		host.configError = { code: "invalid_config", message: resolved.message };
		return host;
	}
	host.mode = resolved.mode;
	if (options.elicit) {
		host.nativeDialogs = createMCPNativeRunner(options.elicit);
	}
	return host;
}

/**
 * A host-owned hook on the assistant's final message. The bridge implements
 * `registerFinalMessageTransform` so the questionnaire can be appended *after the
 * model's final answer* and before the response returns to the caller.
 */
export interface MCPFinalOutputAdapter {
	/**
	 * Register a transform applied to the final assistant message. Returning a
	 * message replaces it; returning `undefined` leaves it unchanged. Returns an
	 * unsubscribe function.
	 */
	registerFinalMessageTransform(transform: (message: unknown) => unknown | undefined): () => void;
}

/**
 * Build a real plain-text output hook for an MCP bridge that can transform the
 * final assistant message.
 *
 * This is the honest counterpart of "deferred": the returned hook is only
 * available because the bridge registered a transform that calls
 * {@link flushAppendix} on the final message. A bridge without such an adapter
 * must not claim the append happened — pass no hook, and `askUser` reports
 * `deferred: false` / `no_output_hook`.
 */
export function createMCPFinalOutputHook(
	adapter: MCPFinalOutputAdapter,
	registry: AppendixRegistry = new AppendixRegistry(),
): PlainTextOutputHook {
	adapter.registerFinalMessageTransform((message) =>
		flushAppendix(message as { role?: unknown; content?: unknown }, registry),
	);
	return createPlainTextHook(registry);
}

function buildElicitationMessage(question: NormalizedQuestion, total: number, invalid: string | undefined): string {
	const lines: string[] = [`【问题 ${question.index + 1}/${total}】${question.title}`];
	if (question.prompt?.trim()) lines.push(question.prompt.trim());
	question.options.forEach((option, index) => {
		const description = option.description?.trim();
		lines.push(`  ${index + 1}. ${option.label}${description ? ` — ${description}` : ""}`);
	});
	if (question.hasDefault && question.default !== undefined) {
		lines.push(`默认值：${question.default}（留空即使用默认值）`);
	}
	lines.push(nativeInputHint(question));
	const body = lines.join("\n");
	return invalid ? `⚠ 输入无效：${invalid}\n\n${body}` : body;
}

/** Elicitation-based native runner. Mirrors the Pi native route's parsing rules. */
export function createMCPNativeRunner(elicit: MCPElicitFn): NativeDialogRunner {
	return {
		async run({ request, deadline, signal, onUpdate }: AskUIInput): Promise<AskUIOutcome> {
			const answers: AskUserAnswer[] = [];
			const total = request.questions.length;
			for (const question of request.questions) {
				let invalid: string | undefined;
				for (;;) {
					if (deadline.expired()) return { kind: "timeout" };
					onUpdate?.(`等待用户回答第 ${question.index + 1}/${total} 题…`);
					const elicitRequest: {
						message: string;
						requestedSchema: Record<string, unknown>;
						timeoutMs?: number;
						signal?: AbortSignal;
					} = {
						message: buildElicitationMessage(question, total, invalid),
						requestedSchema: {
							type: "object",
							properties: {
								answer: {
									type: "string",
									title: "回答",
									description: nativeInputHint(question),
								},
							},
							required: ["answer"],
						},
						timeoutMs: deadline.remainingMs(),
					};
					if (signal) elicitRequest.signal = signal;
					const result = await elicit(elicitRequest);
					if (result.action !== "accept") {
						return { kind: "cancelled" };
					}
					const raw = typeof result.content?.answer === "string" ? result.content.answer : "";
					const parsed = parseNativeAnswer(question, raw);
					if (!parsed.ok) {
						invalid = parsed.error;
						continue;
					}
					if (parsed.value.empty) {
						const fallback = draftFromDefault(question);
						if (fallback) {
							answers.push(toAnswer(question, fallback));
							break;
						}
						invalid = "这是必答题，不能为空。";
						continue;
					}
					answers.push(
						toAnswer(question, {
							selections: parsed.value.selections,
							freeText: parsed.value.freeText ?? "",
							usedDefault: false,
						}),
					);
					break;
				}
			}
			return { kind: "submitted", answers };
		},
	};
}

/** Human-readable preamble for a delivered questionnaire. States it is unanswered. */
export const MCP_DELIVERED_PREAMBLE = "请在下一条消息中回答以下问题（用户尚未回答）。";

/**
 * Compose the MCP tool-result text for a `delivered` (no output hook) result.
 *
 * The questionnaire goes straight into the tool result — the normal outcome of
 * the `text` route — and the model/user is told it is **not yet answered** and
 * to reply with an ordinary message on the next turn. It is never described as
 * answered, and it is not queued anywhere, so it cannot be appended twice.
 */
export function formatMCPDeliveredResult(result: AskUserResult): string {
	return `${MCP_DELIVERED_PREAMBLE}\n\n${result.plainText ?? ""}`;
}

/** JSON Schema for registering the tool with an MCP server. */
export const ASKUSERUI_MCP_INPUT_SCHEMA = AskUserUIParams;

/** The MCP bridge contract, documented as data for bridge authors. */
export const ASKUSERUI_MCP_CONTRACT = {
	toolName: "AskUserUI",
	inputSchema: ASKUSERUI_MCP_INPUT_SCHEMA,
	/** MCP cannot render Pi's TUI: forcing the `custom` route is `unsupported_mode`. */
	customUI: false as const,
	/** The `native` route is runnable only through client elicitation. */
	nativeDialogs: "requires client elicitation support",
	plainText:
		"Normal outcome of the `text` route: the bridge returns the formatted questionnaire directly in the tool result (status `delivered`, deferred:false). The question is unanswered; the user replies with an ordinary message on the next turn. With a real final-message hook the bridge gets status `deferred` (deferred:true) and the questionnaire is appended after the assistant's final answer instead.",
} as const;
