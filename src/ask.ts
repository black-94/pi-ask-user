import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createPiHost } from "./adapters/pi.ts";
import { askUser } from "./core.ts";
import type {
	AskUserDisplayMode,
	AskUserEventSink,
	AskUserHost,
	AskUserMode,
	AskUserResult,
} from "./types.ts";

/** Options for {@link createAskUser}. */
export interface CreateAskUserOptions {
	/**
	 * Explicit UI route for the bound host (`custom` | `native`); highest
	 * precedence. A route the environment cannot run is refused, never
	 * substituted.
	 */
	mode?: AskUserMode;
	/** Explicit display mode; overrides the config file and the request. */
	displayMode?: AskUserDisplayMode;
	/** Explicit overlay toggle key; `null` disables it. Overrides the config file. */
	overlayToggleKey?: string | null;
	/** Explicit timeout (ms) per question; overrides the config file and the request. */
	timeoutPerQuestionMs?: number;
	/** Path to the user config file, or `false` to skip reading it. */
	configFile?: string | false;
	/**
	 * Optional observer for the interactive wait. A direct caller has no Pi event
	 * bus, so nothing is emitted unless this is supplied — there is no fabricated
	 * bus access. Pass a sink to receive `waitStarted`/`waitEnded` around each UI
	 * attempt.
	 */
	events?: AskUserEventSink;
}

/**
 * Options accepted when reusing an already-built {@link AskUserHost}. The config
 * knobs were resolved into the host at its creation, so only call-scoped
 * observers apply here.
 */
export interface CreateAskUserFromHostOptions {
	/** Optional observer for the interactive wait (see {@link CreateAskUserOptions.events}). */
	events?: AskUserEventSink;
}

/**
 * A host-bound, directly callable asker for other extensions — not the model.
 *
 * Availability is readable **before** any UI is shown:
 *
 *  - `isAvailable` — `true` when the bound host has a ready interactive route;
 *  - `notAvailableReason` — why it has none, or `undefined` when it has one.
 *
 * This reports the host's structural/configured capability; it is not a promise
 * that a render will succeed.
 *
 * Calling it resolves to an {@link AskUserResult} for the caller and never
 * forwards anything to the model; there is no plain-text fallback.
 */
export interface AskUser {
	(request: unknown): Promise<AskUserResult>;
	readonly isAvailable: boolean;
	readonly notAvailableReason: string | undefined;
	/** The host this asker is bound to. */
	readonly host: AskUserHost;
}

function isAskUserHost(value: ExtensionContext | AskUserHost): value is AskUserHost {
	return typeof value === "object" && value !== null && "support" in value;
}

/**
 * Bind a directly callable `ask` to a host.
 *
 * Pass a Pi `ExtensionContext` (optionally with explicit options) to probe the
 * environment and read the user config once, or pass a pre-built
 * {@link AskUserHost} to reuse one. The result exposes `isAvailable` /
 * `notAvailableReason` up front, so callers can decide before showing any UI.
 *
 * A direct call has no Pi event bus: pass `events` to observe the interactive
 * wait, or accept that no runtime events are emitted.
 */
export function createAskUser(ctx: ExtensionContext, options?: CreateAskUserOptions): AskUser;
export function createAskUser(host: AskUserHost, options?: CreateAskUserFromHostOptions): AskUser;
export function createAskUser(
	source: ExtensionContext | AskUserHost,
	options: CreateAskUserOptions | CreateAskUserFromHostOptions = {},
): AskUser {
	const host = isAskUserHost(source)
		? source
		: createPiHost(source, options as CreateAskUserOptions);
	const support = host.support;
	const events = options.events;
	const ask = ((request: unknown) =>
		askUser(request, events ? { host, events } : { host })) as AskUser;
	Object.defineProperties(ask, {
		isAvailable: { value: support.status === "available", enumerable: true },
		notAvailableReason: { value: support.status === "available" ? undefined : support.reason, enumerable: true },
		host: { value: host, enumerable: true },
	});
	return ask;
}
