import { combineSignals, createDeadline, safeTimeoutMs } from "./deadline.ts";
import { AskUserValidationError, normalizeAskUserRequest } from "./schema.ts";
import type {
	AskUIInput,
	AskUIOutcome,
	AskUserResult,
	AskUserSupport,
	AskUserOptions,
	AskUserUiPreferences,
	NormalizedRequest,
} from "./types.ts";

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Apply the host's user-configured UI preferences over a normalized request.
 *
 * Precedence, per knob: explicit user preference > request value > built-in
 * default (the latter already baked into the normalized request by the schema).
 * The timeout is recomputed from the effective per-question value so the single
 * shared deadline stays `timeoutPerQuestionMs × questionCount`.
 */
function applyPreferences(request: NormalizedRequest, preferences: AskUserUiPreferences | undefined): NormalizedRequest {
	if (!preferences) return request;
	const displayMode = preferences.displayMode ?? request.displayMode;
	const timeoutPerQuestionMs = preferences.timeoutPerQuestionMs ?? request.timeoutPerQuestionMs;
	if (displayMode === request.displayMode && timeoutPerQuestionMs === request.timeoutPerQuestionMs) return request;
	return {
		...request,
		displayMode,
		timeoutPerQuestionMs,
		totalTimeoutMs: timeoutPerQuestionMs * request.questions.length,
	};
}

/**
 * The single reusable entry point. Accepts raw (usually model-produced) input,
 * normalizes it, then runs it through the route the host resolved at creation.
 *
 * Import this from another extension to reuse the interaction without going
 * through the model:
 *
 * ```ts
 * const result = await askUser({ questions: [...] }, { host: createPiHost(ctx) });
 * ```
 */
export async function askUser(raw: unknown, options: AskUserOptions): Promise<AskUserResult> {
	let request: NormalizedRequest;
	let warnings: string[] = [];
	try {
		const normalized = normalizeAskUserRequest(raw);
		request = normalized.request;
		warnings = normalized.warnings;
	} catch (error) {
		const message =
			error instanceof AskUserValidationError ? error.message : `Invalid request: ${messageOf(error)}`;
		return {
			status: "error",
			answers: [],
			error: { code: "invalid_request", message },
		};
	}
	return askUserNormalized(request, options, warnings);
}

/** Like {@link askUser}, but for an already-normalized request. */
export async function askUserNormalized(
	request: NormalizedRequest,
	options: AskUserOptions,
	warnings: string[] = [],
): Promise<AskUserResult> {
	const { host, signal, onUpdate, now, events } = options;
	// The route was resolved once, when the host was created; the core never
	// re-selects it. A host that cannot prompt here is refused before any
	// rendering, and never in favour of a different route.
	const support = host.support;
	if (support.status !== "available") {
		return finish(supportErrorResult(support), warnings);
	}
	const route = support.route;
	// Cancellation is checked before any route branch, so an already-aborted call
	// never renders an interactive UI.
	if (signal?.aborted) {
		return finish({ status: "aborted", route, answers: [], cancelledReason: "abort" }, warnings);
	}

	// User preferences (explicit option over the user config file) win over the
	// request's own displayMode/timeout; the request wins over the built-in
	// defaults already applied by the schema.
	const effectiveRequest = applyPreferences(request, host.preferences);
	const deadline = createDeadline(effectiveRequest.totalTimeoutMs, now);
	const deadlineController = new AbortController();
	const linked = combineSignals(signal, deadlineController.signal);

	const input: AskUIInput = { request: effectiveRequest, deadline, signal: linked.signal };
	if (onUpdate) input.onUpdate = onUpdate;

	// Wait events are emitted exactly around a real UI attempt: `waitStarted`
	// immediately before the renderer is invoked, and `waitEnded` once on the
	// single settle path. Requests refused before this point emit nothing.
	let waitStarted = false;
	const notifyStart = (): void => {
		if (!events) return;
		try {
			events.waitStarted();
		} catch {
			// An observer must never break the interaction.
		}
		waitStarted = true;
	};
	const settle = (result: AskUserResult): AskUserResult => {
		const finalized = finish(result, warnings);
		if (waitStarted && events) {
			try {
				events.waitEnded(finalized);
			} catch {
				// An observer must never break the interaction.
			}
		}
		return finalized;
	};

	let renderPromise: Promise<AskUIOutcome>;
	notifyStart();
	try {
		if (route === "custom") {
			if (!host.customUI) throw new Error("customUI capability declared without a renderer");
			renderPromise = host.customUI.render(input);
		} else {
			if (!host.nativeDialogs) throw new Error("nativeDialogs capability declared without a runner");
			renderPromise = host.nativeDialogs.run(input);
		}
	} catch (error) {
		linked.dispose();
		return settle(mapOutcome({ kind: "error", message: messageOf(error) }, route, effectiveRequest));
	}

	// The core owns the guarantee: even a renderer that ignores its AbortSignal
	// cannot hang the call. The deadline and the caller's cancellation are raced
	// independently against the renderer; a late renderer result is ignored.
	let race: DeadlineRace;
	try {
		race = await raceWithDeadline(renderPromise, deadline.remainingMs(), signal, () =>
			deadlineController.abort(),
		);
	} finally {
		// Always release the listeners installed on the caller's signal.
		linked.dispose();
	}

	if (race.kind === "timeout") {
		deadlineController.abort();
		return settle({ status: "timeout", route, answers: [] });
	}
	if (race.kind === "abort") {
		deadlineController.abort();
		return settle({ status: "aborted", route, answers: [], cancelledReason: "abort" });
	}

	let outcome = race.outcome;
	// A dismissal that coincides with the shared deadline is a timeout.
	if ((outcome.kind === "cancelled" || outcome.kind === "abort") && deadline.expired()) {
		outcome = { kind: "timeout" };
	}

	return settle(mapOutcome(outcome, route, effectiveRequest));
}

type DeadlineRace =
	| { kind: "outcome"; outcome: AskUIOutcome }
	| { kind: "timeout" }
	| { kind: "abort" };

/**
 * Race a renderer against the deadline and the caller's abort signal.
 *
 * This is what makes the timeout guarantee independent of renderer behaviour: a
 * renderer that never resolves (or that ignores its signal) still yields
 * `timeout`. Late results are discarded, and the rejection path is always
 * handled so a late failure cannot become an unhandled rejection.
 */
function raceWithDeadline(
	render: Promise<AskUIOutcome>,
	remainingMs: number,
	callerSignal: AbortSignal | undefined,
	onDeadline: () => void,
): Promise<DeadlineRace> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let abortHandler: (() => void) | undefined;
	const racers: Array<Promise<DeadlineRace>> = [
		render.then(
			(outcome): DeadlineRace => ({ kind: "outcome", outcome }),
			(error): DeadlineRace => ({ kind: "outcome", outcome: { kind: "error", message: messageOf(error) } }),
		),
		new Promise<DeadlineRace>((resolve) => {
			// `safeTimeoutMs` prevents a >32-bit delay from firing immediately.
			timer = setTimeout(() => {
				onDeadline();
				resolve({ kind: "timeout" });
			}, safeTimeoutMs(remainingMs));
		}),
	];
	if (callerSignal) {
		racers.push(
			new Promise<DeadlineRace>((resolve) => {
				if (callerSignal.aborted) {
					resolve({ kind: "abort" });
					return;
				}
				abortHandler = () => resolve({ kind: "abort" });
				callerSignal.addEventListener("abort", abortHandler, { once: true });
			}),
		);
	}
	return Promise.race(racers).finally(() => {
		if (timer) clearTimeout(timer);
		// Remove the listener when the render settled first, so repeated calls do
		// not accumulate listeners on a long-lived caller signal.
		if (abortHandler && callerSignal) callerSignal.removeEventListener("abort", abortHandler);
	});
}

/**
 * Turn a non-`available` support status into the matching error result.
 *
 * Nothing is rendered and no question is asked. An explicitly configured route
 * that cannot run is reported as `unsupported_mode` and names that requested
 * route; an environment with no usable UI reports `unsupported_mode` with no
 * route at all, so no default is ever fabricated.
 */
function supportErrorResult(support: Exclude<AskUserSupport, { status: "available" }>): AskUserResult {
	if (support.status === "invalid_config") {
		return { status: "error", answers: [], error: { code: "invalid_config", message: support.reason } };
	}
	if (support.status === "configured_unavailable") {
		return {
			status: "error",
			route: support.configured,
			answers: [],
			error: { code: "unsupported_mode", message: support.reason },
		};
	}
	return { status: "error", answers: [], error: { code: "unsupported_mode", message: support.reason } };
}

function mapOutcome(
	outcome: AskUIOutcome,
	route: "custom" | "native",
	request: NormalizedRequest,
): AskUserResult {
	switch (outcome.kind) {
		case "submitted": {
			const answers = outcome.answers ?? [];
			if (answers.length !== request.questions.length) {
				return {
					status: "error",
					route,
					answers,
					error: {
						code: "internal",
						message: `${route} UI returned ${answers.length} answers, expected ${request.questions.length}.`,
					},
				};
			}
			const empty = answers.find(
				(answer) => answer.selections.length === 0 && (answer.freeText ?? "").trim() === "",
			);
			if (empty) {
				return {
					status: "error",
					route,
					answers,
					error: { code: "empty_answer", message: `The answer to question "${empty.title}" is empty.` },
				};
			}
			return { status: "answered", route, answers };
		}
		case "cancelled":
			return { status: "aborted", route, answers: [], cancelledReason: "user" };
		case "abort":
			return { status: "aborted", route, answers: [], cancelledReason: "abort" };
		case "timeout":
			return { status: "timeout", route, answers: [] };
		case "error":
			return {
				status: "error",
				route,
				answers: [],
				error: {
					code: route === "custom" ? "custom_ui_failed" : "native_ui_failed",
					message: outcome.message ?? `${route} UI failed.`,
				},
			};
	}
}

function finish(result: AskUserResult, warnings: string[]): AskUserResult {
	if (warnings.length > 0) result.warnings = warnings;
	return result;
}
