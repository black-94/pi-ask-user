/**
 * Runtime event emission for the registered `ask_user` tool.
 *
 * These events carry *result semantics* that Pi's generic `ui_prompt_start` /
 * `ui_prompt_end` do not: whether the wait ended with an answer, a dismissal, a
 * timeout, or an error — and through which route.
 *
 * Two families are emitted:
 *
 *  1. `herdr:blocked` — `{ active: true, label, callId? }` only when the tool is
 *     actually entering the interactive wait, and exactly one matching
 *     `{ active: false, callId? }` afterwards, for every outcome (answered,
 *     aborted, timeout, error). Invalid or unavailable requests never emit it,
 *     because no UI is attempted.
 *  2. `ask:answered` / `ask:aborted` / `ask:timeout` / `ask:error` — exactly once
 *     per UI attempt, carrying the correlation id and the route/status. By
 *     default the full question, answers, and free text are **never** broadcast;
 *     only non-sensitive metadata leaves the extension.
 *
 * A direct {@link createAskUser} caller has no Pi event bus; it may inject an
 * {@link AskUserEventSink} instead (or accept the deliberate absence). This
 * module never fabricates access to a bus.
 */
import type { AskUserEventSink, AskUserResult, AskUserRoute } from "./types.ts";

/** The minimal event-bus surface used here (structurally matches Pi's EventBus). */
export interface AskEventBus {
	emit(channel: string, data: unknown): void;
}

export const HERDR_BLOCKED = "herdr:blocked";
export const ASK_ANSWERED = "ask:answered";
export const ASK_ABORTED = "ask:aborted";
export const ASK_TIMEOUT = "ask:timeout";
export const ASK_ERROR = "ask:error";

/** Fixed label for the blocked/idle indicator. */
export const WAITING_LABEL = "Waiting for user response";

function optionalCallId(callId: string | undefined): { callId?: string } {
	return callId === undefined || callId === "" ? {} : { callId };
}

/**
 * Build the Pi event-bus sink for one tool call. Returns `undefined` when no
 * usable bus is present, so the caller emits nothing rather than faking it.
 * Emission failures are swallowed: events must never break the interaction.
 */
export function createAskEventSink(bus: AskEventBus | undefined, callId?: string): AskUserEventSink | undefined {
	if (!bus || typeof bus.emit !== "function") return undefined;
	const emit = (channel: string, data: unknown): void => {
		try {
			bus.emit(channel, data);
		} catch {
			// An observer must never break the interaction.
		}
	};
	return {
		waitStarted(): void {
			emit(HERDR_BLOCKED, { active: true, label: WAITING_LABEL, ...optionalCallId(callId) });
		},
		waitEnded(result: AskUserResult): void {
			emit(HERDR_BLOCKED, { active: false, ...optionalCallId(callId) });
			const correlation: { callId?: string; route?: AskUserRoute } = { ...optionalCallId(callId) };
			if (result.route !== undefined) correlation.route = result.route;
			switch (result.status) {
				case "answered":
					emit(ASK_ANSWERED, { ...correlation, status: "answered" });
					break;
				case "aborted":
					emit(ASK_ABORTED, { ...correlation, status: "aborted", cancelledReason: result.cancelledReason ?? "user" });
					break;
				case "timeout":
					emit(ASK_TIMEOUT, { ...correlation, status: "timeout" });
					break;
				case "error":
					emit(ASK_ERROR, { ...correlation, status: "error", errorCode: result.error?.code });
					break;
			}
		},
	};
}

/** The outcome-event channel for a status, exposed for documentation/tests. */
export function outcomeChannel(status: AskUserResult["status"]): string {
	switch (status) {
		case "answered":
			return ASK_ANSWERED;
		case "aborted":
			return ASK_ABORTED;
		case "timeout":
			return ASK_TIMEOUT;
		case "error":
			return ASK_ERROR;
	}
}
