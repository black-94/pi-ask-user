/**
 * Example: bridge AskUserUI into an MCP server.
 *
 * An MCP host cannot render Pi's TUI, so `createMCPHost` never binds the custom
 * route (forcing it yields `unsupported_mode`). The route comes only from
 * trusted configuration — the `mode` parameter below, else the
 * `PI_ASK_USER_UI_MODE` environment variable, else the default `native`. It is
 * **never** derived from whether the client declared elicitation: the optional
 * `elicit` implementation is bound when present, but choosing the route from
 * its presence would be capability detection. With the default `native` and no
 * bound elicitation the call fails with `unsupported_mode`; a bridge serving a
 * generic no-elicitation client is configured with `mode: "text"` explicitly by
 * its embedder, not by this file.
 *
 * Two normal plain-text outcomes of the `text` route, neither of which claims
 * the question was answered:
 *
 *  - **No final-output hook** (a generic MCP client): `askUser` returns
 *    `status: "delivered"` with the formatted questionnaire in `plainText`, and
 *    the bridge puts it straight into the tool result. The user replies with an
 *    ordinary message on the next turn. This is the normal fallback — not an
 *    error, so it is not reported as `no_output_hook`.
 *  - **A real final-message hook** (the server wraps the model loop): implement
 *    {@link MCPFinalOutputAdapter} and build the hook with
 *    `createMCPFinalOutputHook`, which registers a transform calling
 *    `flushAppendix`. Then `askUser` returns `status: "deferred"` and the
 *    questionnaire is appended after the assistant's final answer.
 *
 * This file is illustrative; it does not import an MCP SDK.
 */
import {
	ASKUSERUI_MCP_INPUT_SCHEMA,
	askUser,
	createMCPFinalOutputHook,
	createMCPHost,
	formatMCPDeliveredResult,
	type AskUserUIMode,
	type MCPFinalOutputAdapter,
} from "../src/index.ts";

interface McpServer {
	tool(
		name: string,
		schema: unknown,
		handler: (args: unknown) => Promise<{ content: Array<{ type: "text"; text: string }> }>,
	): void;
	/** Present when the client negotiated elicitation support. */
	elicit?: (request: {
		message: string;
		requestedSchema: Record<string, unknown>;
		timeoutMs?: number;
		signal?: AbortSignal;
	}) => Promise<{ action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> }>;
	/** Present only if the server really owns a hook on the final assistant message. */
	finalOutput?: MCPFinalOutputAdapter;
}

/** Trusted bridge configuration. Nothing here is derived from the client. */
export interface RegisterAskUserUiBridgeOptions {
	/**
	 * Explicitly configured route: `custom` | `native` | `text`. Trusted
	 * programmatic configuration — the highest precedence for this bridge.
	 * When omitted, `PI_ASK_USER_UI_MODE` applies, and otherwise the default
	 * `native` (which needs a bound elicitation implementation to run).
	 */
	mode?: AskUserUIMode;
	/** Environment source for `PI_ASK_USER_UI_MODE`. Defaults to `process.env`. */
	env?: Record<string, string | undefined>;
}

export function registerAskUserUiTool(server: McpServer, options: RegisterAskUserUiBridgeOptions = {}): void {
	const host = createMCPHost({
		// Bind the implementation if the client provides one — but never choose
		// the route from its presence. Route = options.mode > env > native.
		...(server.elicit ? { elicit: server.elicit.bind(server) } : {}),
		...(options.mode ? { mode: options.mode } : {}),
		...(options.env ? { env: options.env } : {}),
		// The hook is only available when the bridge registered a real transform.
		...(server.finalOutput ? { plainTextHook: createMCPFinalOutputHook(server.finalOutput) } : {}),
	});

	server.tool("AskUserUI", ASKUSERUI_MCP_INPUT_SCHEMA, async (args) => {
		const result = await askUser(args, { host });

		if (result.status === "answered") {
			return { content: [{ type: "text", text: JSON.stringify(result.answers) }] };
		}
		if (result.status === "delivered") {
			// Normal fallback: deliver the formatted questionnaire in the tool result.
			// The user has NOT answered yet and will reply on the next turn.
			return { content: [{ type: "text", text: formatMCPDeliveredResult(result) }] };
		}
		if (result.status === "deferred") {
			// A real transform is registered and will append the questionnaire to the
			// final assistant message via flushAppendix.
			return {
				content: [{ type: "text", text: "Questionnaire queued on the bridge's final-output hook." }],
			};
		}
		return { content: [{ type: "text", text: `AskUserUI ${result.status}: ${result.error?.message ?? ""}` }] };
	});
}
