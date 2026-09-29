import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createPiHost } from "./adapters/pi.ts";
import { askUser } from "./core.ts";
import type { AskUserHost, AskUserMode, AskUserResult } from "./types.ts";

/** Options for {@link createAskUser}. */
export interface CreateAskUserOptions {
	/**
	 * Explicit UI route for the bound host (`custom` | `native`); highest
	 * precedence. A route the environment cannot run is refused, never
	 * substituted.
	 */
	mode?: AskUserMode;
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
 * Pass a Pi `ExtensionContext` (optionally with an explicit `{ mode }`) to probe
 * the environment once, or pass a pre-built {@link AskUserHost} to reuse one. The
 * result exposes `isAvailable` / `notAvailableReason` up front, so callers can
 * decide before showing any UI.
 */
export function createAskUser(ctx: ExtensionContext, options?: CreateAskUserOptions): AskUser;
export function createAskUser(host: AskUserHost): AskUser;
export function createAskUser(source: ExtensionContext | AskUserHost, options: CreateAskUserOptions = {}): AskUser {
	const host = isAskUserHost(source)
		? source
		: createPiHost(source, options.mode === undefined ? {} : { mode: options.mode });
	const support = host.support;
	const ask = ((request: unknown) => askUser(request, { host })) as AskUser;
	Object.defineProperties(ask, {
		isAvailable: { value: support.status === "available", enumerable: true },
		notAvailableReason: { value: support.status === "available" ? undefined : support.reason, enumerable: true },
		host: { value: host, enumerable: true },
	});
	return ask;
}
