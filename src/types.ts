/**
 * Public types for AskUser.
 *
 * AskUser is a host-adaptive "ask the user" interaction primitive. A request is
 * answered through one of two routes:
 *
 *  - `custom` — a custom terminal UI (only a real Pi TUI)
 *  - `native` — native input dialogs (`ctx.hasUI` + callable input), one question
 *    at a time
 *
 * The route is resolved **once, when the host adapter is created**, from
 * trustworthy inputs only:
 *
 *  1. an explicit configured `mode`, which wins whenever it is supplied, or
 *  2. otherwise an initialisation-time probe of the bound implementations —
 *     `custom` when both can run, `native` when only that can run.
 *
 * If an explicitly configured route cannot run here, it is reported as
 * unsupported; the probe result is never substituted for it. If nothing can
 * run, there is no route at all. The model's tool parameters can never
 * influence any of this.
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
	/** Optional Markdown preview. Custom UI only; never shown on the native route. */
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
 * - `aborted`   — the user dismissed the interaction (or the caller aborted).
 * - `timeout`   — the shared deadline expired before an answer was given.
 * - `error`     — the renderer failed; or the forced mode is invalid
 *                 (`invalid_config`) or unsupported here (`unsupported_mode`).
 *                 Never a fallback to another route.
 */
export type AskUserStatus = "answered" | "aborted" | "timeout" | "error";
export type AskUserRoute = "custom" | "native";
/**
 * The configured route a host is asked to use: the same two values as
 * {@link AskUserRoute}. Configuration never falls back — an unsupported value is
 * an error.
 */
export type AskUserMode = AskUserRoute;
export type AskUserErrorCode =
	| "invalid_request"
	| "custom_ui_failed"
	| "native_ui_failed"
	| "empty_answer"
	| "invalid_config"
	| "unsupported_mode"
	| "not_initialized"
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
	 * Which route serviced the request. Absent when no route ran at all
	 * (`invalid_request`, `invalid_config`, or an environment with no usable UI).
	 * When an explicitly configured route was refused as unavailable, it names
	 * that requested route.
	 */
	route?: AskUserRoute;
	answers: AskUserAnswer[];
	/** Populated when `status === "aborted"`. */
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
 * callable native runner. They describe what can really run here; they never
 * invent a route.
 */
export interface HostCapabilities {
	customUI: boolean;
	nativeDialogs: boolean;
}

/** The structural implementation surface probed to derive {@link HostCapabilities}. */
export interface HostImplementations {
	customUI?: CustomUIRenderer;
	nativeDialogs?: NativeDialogRunner;
}

/**
 * The outcome of resolving a host's route, computed once at host creation.
 *
 * `available` is the probe result (the modes that can really run here), in
 * priority order with `custom` first. `route` is present only when a request
 * will actually be serviced — never a fabricated default.
 */
export interface AskUserSupportAvailable {
	status: "available";
	/** The route a request will be serviced through. */
	route: AskUserRoute;
	/** `configured` when an explicit mode was supplied, else `probed`. */
	source: "configured" | "probed";
	capabilities: HostCapabilities;
	available: AskUserRoute[];
}

/** An explicit mode was configured but cannot run here. No fallback is taken. */
export interface AskUserSupportConfiguredUnavailable {
	status: "configured_unavailable";
	/** The explicitly configured route, which cannot run in this environment. */
	configured: AskUserRoute;
	capabilities: HostCapabilities;
	available: AskUserRoute[];
	reason: string;
}

/** Nothing can run here: neither a custom TUI nor native dialogs. */
export interface AskUserSupportNoUI {
	status: "no_available_ui";
	capabilities: HostCapabilities;
	available: [];
	reason: string;
}

/** The configured value is not a known route. */
export interface AskUserSupportInvalidConfig {
	status: "invalid_config";
	capabilities: HostCapabilities;
	/** What could run here, had the configuration been valid. */
	available: AskUserRoute[];
	reason: string;
}

/**
 * A discriminated union describing whether — and how — a host can prompt the
 * user right now, without actually prompting. Narrow on `status`: the `route`
 * field exists only for `"available"`.
 */
export type AskUserSupport =
	| AskUserSupportAvailable
	| AskUserSupportConfiguredUnavailable
	| AskUserSupportNoUI
	| AskUserSupportInvalidConfig;

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
 * A trusted host adapter. Each declared capability is bound to the object that
 * implements it: `customUI` is present iff the host really renders custom UI,
 * `nativeDialogs` is present iff the host really shows native dialogs. There is
 * no way to declare a capability without the implementation.
 */
export interface AskUserHost {
	name: string;
	/**
	 * Resolved once, when this host was created, from the explicit configuration
	 * and the bound implementations. The core honours it verbatim: it never
	 * re-selects a route per request.
	 */
	support: AskUserSupport;
	/** Bound wherever the custom route can really run. */
	customUI?: CustomUIRenderer;
	/** Bound wherever the native route can really run. */
	nativeDialogs?: NativeDialogRunner;
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
