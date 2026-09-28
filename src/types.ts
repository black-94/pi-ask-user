/**
 * Public types for AskUserUI.
 *
 * AskUserUI is a host-adaptive "ask the user" interaction primitive. A request
 * can be answered through one of three routes:
 *
 *  - `custom`     — a custom terminal UI (only when a host declares `customUI`)
 *  - `native`     — one native input dialog per question (declared `nativeDialogs`)
 *  - `plain_text` — no UI: options are appended to the assistant output as text
 *
 * Capabilities are declared by a trusted host adapter and are bound to a
 * concrete implementation object, so a capability cannot be declared without
 * something that actually performs it. The model never supplies capabilities.
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
 * - `error`     — the renderer or a declared output hook failed; never a fallback.
 * - `deferred`  — no UI, but a final-output hook accepted the questionnaire for
 *                 an append after the model's final answer.
 * - `delivered` — no UI and no output hook: the formatted questionnaire is
 *                 returned in `plainText` for the caller to hand to the user
 *                 directly. This is a normal fallback, not an error; the question
 *                 is still unanswered and the caller replies on the next turn.
 */
export type AskUserStatus = "answered" | "cancelled" | "timeout" | "error" | "deferred" | "delivered";
export type AskUserRoute = "custom" | "native" | "plain_text";
export type AskUserErrorCode =
	| "invalid_request"
	| "custom_ui_failed"
	| "native_ui_failed"
	| "empty_answer"
	| "no_output_hook"
	| "internal";

/** Result of {@link askUser}. */
export interface AskUserResult {
	status: AskUserStatus;
	/** Which route serviced the request. */
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
	error?: { code: AskUserErrorCode; message: string };
}

// ---------------------------------------------------------------------------
// Host adapter contract
// ---------------------------------------------------------------------------

/** Declared capabilities of a host. Derived from the adapter, never from the model. */
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
 * Output hook used by the no-UI route. It appends the formatted questionnaire to
 * the assistant output before control returns to the caller. `available` must be
 * false when the host has no working output hook, so callers can fall back to
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
	customUI?: CustomUIRenderer;
	nativeDialogs?: NativeDialogRunner;
	plainText?: PlainTextOutputHook;
}

/** Options for {@link askUser}. */
export interface AskUserOptions {
	host: AskUserHost;
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
