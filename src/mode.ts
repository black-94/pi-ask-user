import type { AskUserMode } from "./types.ts";

/**
 * The UI routes AskUser supports, in probe-priority order.
 *
 * A route is never read from the environment: it is either passed explicitly to
 * the host-factory (`createAskUserHost({ mode })`, `createPiHost(ctx, { mode })`,
 * `registerAskUser(pi, { mode })`) or discovered from the implementations
 * the host can really bind (see `createAskUserHost`). Model tool parameters can
 * never influence it.
 */

/** The accepted routes, in documentation and probe-priority order. */
export const UI_MODES: readonly AskUserMode[] = ["custom", "native"];

export function isUIMode(value: unknown): value is AskUserMode {
	return typeof value === "string" && (UI_MODES as readonly string[]).includes(value);
}
