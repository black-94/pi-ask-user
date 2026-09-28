import type { Deadline } from "./types.ts";

/**
 * Largest delay Node's `setTimeout` accepts (a 32-bit signed integer). Larger
 * values are clamped by Node to ~1 ms, which would fire a timer immediately and
 * turn a huge timeout into an instant one. We clamp instead.
 */
export const MAX_SAFE_TIMEOUT_MS = 2_147_483_647;

/** Clamp a requested timeout to a value `setTimeout` can honour. */
export function safeTimeoutMs(ms: number): number {
	if (!Number.isFinite(ms) || ms <= 0) return 0;
	return Math.min(Math.floor(ms), MAX_SAFE_TIMEOUT_MS);
}

/**
 * Create a single overall deadline for a questionnaire.
 *
 * The deadline is always `timeoutMs` (which callers compute as
 * `timeoutPerQuestionMs × questionCount`). It is clamped to
 * {@link MAX_SAFE_TIMEOUT_MS} so `setTimeout` never overflows. Every interaction
 * for the questionnaire shares this one deadline; native dialogs receive only
 * the remaining time. A deadline never degrades to another route.
 */
export function createDeadline(totalMs: number, now: () => number = Date.now): Deadline {
	const startedAt = now();
	const safeTotal = safeTimeoutMs(totalMs);
	const expiresAt = safeTotal === 0 ? startedAt : startedAt + safeTotal;
	return {
		startedAt,
		expiresAt,
		remainingMs(): number {
			return Math.max(0, expiresAt - now());
		},
		expired(): boolean {
			return now() >= expiresAt;
		},
	};
}

/** A signal plus the cleanup for the listeners it installed on its sources. */
export interface LinkedSignal {
	signal: AbortSignal;
	/** Remove listeners from the source signals. Idempotent. */
	dispose(): void;
}

/**
 * Combine the caller's abort signal with a deadline-driven abort signal.
 *
 * Unlike `AbortSignal.any`, this returns an explicit `dispose()` so listeners
 * installed on the caller's signal are removed once the interaction settles and
 * do not accumulate across repeated calls.
 */
export function combineSignals(caller: AbortSignal | undefined, deadlineSignal: AbortSignal): LinkedSignal {
	const controller = new AbortController();
	const onDeadline = () => controller.abort(deadlineSignal.reason);
	const onCaller = () => controller.abort(caller?.reason);
	let disposed = false;

	if (deadlineSignal.aborted) controller.abort(deadlineSignal.reason);
	else deadlineSignal.addEventListener("abort", onDeadline, { once: true });

	if (caller) {
		if (caller.aborted) controller.abort(caller.reason);
		else caller.addEventListener("abort", onCaller, { once: true });
	}

	return {
		signal: controller.signal,
		dispose() {
			if (disposed) return;
			disposed = true;
			deadlineSignal.removeEventListener("abort", onDeadline);
			if (caller) caller.removeEventListener("abort", onCaller);
		},
	};
}
