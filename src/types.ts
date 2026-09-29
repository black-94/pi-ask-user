/**
 * Public types for AskUserUI.
 *
 * AskUserUI is a host-adaptive "ask the user" interaction primitive. A request
 * is answered through one of three routes:
 *
 *  - `custom` — a custom terminal UI (only a real Pi TUI)
 *  - `native` — one native input dialog per question (`ctx.hasUI` + callable input)
 *  - `text`   — no UI: options are appended to the assistant output as text
 *
 * The route is **forced**, never detected: a trusted host adapter resolves the
 * UI mode and the core honours exactly that mode. Resolution order is
 * programmatic `mode` > `PI_ASK_USER_UI_MODE` > default `native`. The model's
 * tool parameters can never influence it, and an unsupported forced mode is an
 * actionable error — there is no probing and no silent fallback.
 *
 * Capabilities remain bound to a concrete implementation object, so a route
 * cannot be declared without something that actually performs it.
 */

/** The kind of question. */
export type QuestionKind = "single" | "multi" | "input";

/** One selectable option. `preview` is rendered only by the custom UI. */
export interface AskUserOption {
	/** Short label shown in the list and returned as the answer value. */
	label: string;
	/** One-line explanation rendered next to the label. */
	description?: string;
	/** Optional Markdown preview. Custom UI only; never shown on native/plain-text routes. */
	preview?: string;
}

/** One question in a questionnaire. */
export interface AskUserQuestion {
	/** Stable id. Generated (`q1`, `q2`, ...) when omitted. */
	id?: string;
	/** Question heading (required). */
	title: string;
	/** Optional extra hint or context rendered under the heading. */
	prompt?: string;
	/** `single` = choose one, `multi` = choose several, `input` = free text only. */
	kind: QuestionKind;
	/** 1..5 options. Required for `single`/`multi`; ignored for `input`. */
	options?: AskUserOption[];
	/**
	 * Default answer. When present the question may be skipped and the default
	 * is used; when absent the question must be answered.
	 */
	default?: string;
}

/** A model-facing (or caller-facing) request. */
export interface AskUserRequest {
	/** 1..5 questions. */
	questions: AskUserQuestion[];
	/** Optional heading shown above the questionnaire. */
	header?: string;
	/** Custom-UI presentation. Defaults to `overlay`. */
	displayMode?: "overlay" | "inline";
	/**
	 * Base timeout per question in milliseconds. Defaults to 60000.
	 *
	 * The questionnaire's single deadline is always
	 * `timeoutPerQuestionMs × questionCount`; there is no absolute override.
	 */
	timeoutPerQuestionMs?: number;
}

/** A single resolved answer. */
export interface AskUserAnswer {
	index: number;
	id: string;
	title: string;
	kind: QuestionKind;
	/** Selected option labels. Empty for free-text-only answers. */
	selections: string[];
	/** Trailing free-text input, when provided. */
	freeText?: string;
	/** True when the answer came from the question default rather than user input. */
	usedDefault: boolean;
}

/**
 * - `answered`  — the user answered through a custom or native UI.
 * - `cancelled` — the user dismissed the interaction (or the caller aborted).
 * - `timeout`   — the shared deadline expired before an answer was given.
 * - `error`     — the renderer or a declared output hook failed; or the forced
 *                 mode is invalid (`invalid_config`) or unsupported here
 *                 (`unsupported_mode`). Never a fallback to another route.
 * - `deferred`  — the `text` route with a final-output hook that accepted the
 *                 questionnaire for an append after the model's final answer.
 * - `delivered` — the `text` route with no output hook: the formatted
 *                 questionnaire is returned in `plainText` for the caller to hand
 *                 to the user directly. This is a normal outcome, not an error;
 *                 the question is still unanswered and the caller replies on the
 *                 next turn.
 */
export type AskUserStatus = "answered" | "cancelled" | "timeout" | "error" | "deferred" | "delivered";
export type AskUserRoute = "custom" | "native" | "text";
/**
 * The configured UI route: the same three values as {@link AskUserRoute}.
 * Configuration never falls back — an unsupported value is an error.
 */
export type AskUserUIMode = AskUserRoute;
export type AskUserErrorCode =
	| "invalid_request"
	| "custom_ui_failed"
	| "native_ui_failed"
	| "empty_answer"
	| "no_output_hook"
	| "invalid_config"
	| "unsupported_mode"
	| "internal";

/** An actionable failure: what went wrong and what to do about it. */
export interface AskUserError {
	code: AskUserErrorCode;
	message: string;
}

/** Result of {@link askUser}. */
export interface AskUserResult {
	status: AskUserStatus;
	/**
	 * Which route serviced the request. For `invalid_config` no route ran: the
	 * reported value is `text` and `plainText` is never populated — it is not a
	 * fallback, the request was refused.
	 */
	route: AskUserRoute;
	answers: AskUserAnswer[];
	/**
	 * Formatted plain-text questionnaire. Populated for the no-UI routes: it is
	 * queued on a final-output hook (`deferred`) or returned inline for the caller
	 * to deliver (`delivered`).
	 */
	plainText?: string;
	/**
	 * True only when {@link PlainTextOutputHook.queue} accepted the appendix for a
	 * deferred append after the model's final answer. False means the caller must
	 * deliver `plainText` itself (normal for hosts without a final-output hook).
	 */
	deferred: boolean;
	/** Populated when `status === "cancelled"`. */
	cancelledReason?: "user" | "abort";
	/** Non-fatal normalization notes (e.g. dropped duplicate options). */
	warnings?: string[];
	error?: AskUserError;
}

// ---------------------------------------------------------------------------
// Host adapter contract
// ---------------------------------------------------------------------------

/**
 * Structural capabilities of a host: `customUI` is true only when the adapter
 * binds a callable custom renderer, `nativeDialogs` only when it binds a
 * callable native runner. They verify that a *forced* mode can really run; they
 * are never used to pick a route.
 */
export interface HostCapabilities {
	customUI: boolean;
	nativeDialogs: boolean;
}

/** Shared input passed to custom/native renderers. */
export interface AskUIInput {
	request: NormalizedRequest;
	deadline: Deadline;
	signal?: AbortSignal;
	/** Report progress such as "Waiting for user input...". */
	onUpdate?: (text: string) => void;
}

/** Outcome of an interactive render attempt. */
export interface AskUIOutcome {
	kind: "submitted" | "cancelled" | "timeout" | "abort" | "error";
	answers?: AskUserAnswer[];
	message?: string;
}

export interface CustomUIRenderer {
	/** Render the full questionnaire. Must not silently degrade to another route. */
	render(input: AskUIInput): Promise<AskUIOutcome>;
}

export interface NativeDialogRunner {
	/** Walk the questionnaire one native dialog at a time. Must not degrade. */
	run(input: AskUIInput): Promise<AskUIOutcome>;
}

/**
 * Output hook used by the `text` route. It appends the formatted questionnaire
 * to the assistant output before control returns to the caller. `available` must
 * be false when the host has no working output hook, so callers can fall back to
 * delivering {@link AskUserResult.plainText} themselves.
 */
export interface PlainTextOutputHook {
	readonly available: boolean;
	queue(text: string): void;
}

/**
 * A trusted host adapter. Each declared capability is bound to the object that
 * implements it: `customUI` is present iff the host really renders custom UI,
 * `nativeDialogs` is present iff the host really shows native dialogs. There is
 * no way to declare a capability without the implementation.
 */
export interface AskUserHost {
	name: string;
	/**
	 * The route this host is configured to use, already resolved by the trusted
	 * adapter (programmatic option > `PI_ASK_USER_UI_MODE` > default `native`).
	 * The core honours it as a forced route unless the call supplies its own
	 * {@link AskUserOptions.mode}, which overrides it.
	 */
	mode?: AskUserUIMode;
	/**
	 * Set by the adapter when its own UI configuration is invalid (e.g. an
	 * unparsable `PI_ASK_USER_UI_MODE`). Without a per-call `mode` the core
	 * reports it as `status: "error"` with code `invalid_config` instead of
	 * falling back to another route; a per-call `mode` overrides it.
	 */
	configError?: AskUserError;
	/**
	 * Bound wherever the implementation can really run, independently of the
	 * configured {@link mode} — so a per-call mode override has something to
	 * run. A forced route with no bound implementation is `unsupported_mode`.
	 */
	customUI?: CustomUIRenderer;
	nativeDialogs?: NativeDialogRunner;
	plainText?: PlainTextOutputHook;
}

/** Options for {@link askUser}. */
export interface AskUserOptions {
	host: AskUserHost;
	/**
	 * Per-call forced UI route — the single highest precedence in the whole
	 * chain. It overrides the host adapter's configured mode *and* the
	 * adapter's own `configError` (including an invalid environment value), so
	 * it only succeeds when the adapter has bound a callable implementation for
	 * it; otherwise the result is `unsupported_mode`. An invalid value is an
	 * error (`invalid_config`), never a fallback.
	 */
	mode?: AskUserUIMode;
	signal?: AbortSignal;
	onUpdate?: (text: string) => void;
	/** Injectable clock, used by tests. Defaults to `Date.now`. */
	now?: () => number;
}

// ---------------------------------------------------------------------------
// Normalized request / deadline
// ---------------------------------------------------------------------------

export interface NormalizedQuestion {
	id: string;
	index: number;
	title: string;
	prompt?: string;
	kind: QuestionKind;
	options: AskUserOption[];
	default?: string;
	hasDefault: boolean;
}

export interface NormalizedRequest {
	header?: string;
	questions: NormalizedQuestion[];
	displayMode: "overlay" | "inline";
	timeoutPerQuestionMs: number;
	totalTimeoutMs: number;
}

export interface Deadline {
	readonly startedAt: number;
	readonly expiresAt: number;
	remainingMs(): number;
	expired(): boolean;
}
