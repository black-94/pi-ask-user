import { combineSignals, createDeadline, safeTimeoutMs } from "./deadline.ts";
import { formatPlainText } from "./plaintext.ts";
import { hostCapabilities, pickRoute } from "./route.ts";
import { AskUserValidationError, normalizeAskUserRequest } from "./schema.ts";
import type { AskUIInput, AskUIOutcome, AskUserOptions, AskUserResult, NormalizedRequest } from "./types.ts";

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * The single reusable entry point. Accepts raw (usually model-produced) input,
 * normalizes it, then routes it through the host's declared capabilities.
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
			error instanceof AskUserValidationError ? error.message : `请求无效：${messageOf(error)}`;
		return {
			status: "error",
			route: "plain_text",
			answers: [],
			deferred: false,
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
	const { host, signal, onUpdate, now } = options;
	const capabilities = hostCapabilities(host);
	const route = pickRoute(capabilities);
	// Cancellation is checked before any route branch, so an already-aborted call
	// never queues a plain-text questionnaire or renders an interactive UI.
	if (signal?.aborted) {
		return finish({ status: "cancelled", route, answers: [], deferred: false, cancelledReason: "abort" }, warnings);
	}

	const plainText = formatPlainText(request);
	if (route === "plain_text") {
		const hook = host.plainText;
		// A working output hook defers the append until after the model's final
		// answer (Pi's `message_end` path).
		if (hook && hook.available) {
			try {
				hook.queue(plainText);
				return finish({ status: "deferred", route, answers: [], plainText, deferred: true }, warnings);
			} catch (error) {
				// A declared hook that fails is a real error, not a normal fallback.
				return finish(
					{
						status: "error",
						route,
						answers: [],
						plainText,
						deferred: false,
						error: { code: "no_output_hook", message: `输出适配层追加失败：${messageOf(error)}` },
					},
					warnings,
				);
			}
		}
		// No output hook at all (e.g. a generic MCP client): this is a normal
		// fallback. Deliver the formatted questionnaire inline; the question stays
		// unanswered and the caller replies on the next turn.
		return finish({ status: "delivered", route, answers: [], plainText, deferred: false }, warnings);
	}

	const deadline = createDeadline(request.totalTimeoutMs, now);
	const deadlineController = new AbortController();
	const linked = combineSignals(signal, deadlineController.signal);

	const input: AskUIInput = { request, deadline, signal: linked.signal };
	if (onUpdate) input.onUpdate = onUpdate;

	let renderPromise: Promise<AskUIOutcome>;
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
		return finish(mapOutcome({ kind: "error", message: messageOf(error) }, route, request), warnings);
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
		return finish({ status: "timeout", route, answers: [], deferred: false }, warnings);
	}
	if (race.kind === "abort") {
		deadlineController.abort();
		return finish({ status: "cancelled", route, answers: [], deferred: false, cancelledReason: "abort" }, warnings);
	}

	let outcome = race.outcome;
	// A dismissal that coincides with the shared deadline is a timeout.
	if ((outcome.kind === "cancelled" || outcome.kind === "abort") && deadline.expired()) {
		outcome = { kind: "timeout" };
	}

	return finish(mapOutcome(outcome, route, request), warnings);
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
					deferred: false,
					error: {
						code: "internal",
						message: `${route} UI 返回了 ${answers.length} 个答案，期望 ${request.questions.length} 个。`,
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
					deferred: false,
					error: { code: "empty_answer", message: `问题 “${empty.title}” 的答案为空。` },
				};
			}
			return { status: "answered", route, answers, deferred: false };
		}
		case "cancelled":
			return { status: "cancelled", route, answers: [], deferred: false, cancelledReason: "user" };
		case "abort":
			return { status: "cancelled", route, answers: [], deferred: false, cancelledReason: "abort" };
		case "timeout":
			return { status: "timeout", route, answers: [], deferred: false };
		case "error":
			return {
				status: "error",
				route,
				answers: [],
				deferred: false,
				error: {
					code: route === "custom" ? "custom_ui_failed" : "native_ui_failed",
					message: outcome.message ?? `${route} UI 运行失败。`,
				},
			};
	}
}

function finish(result: AskUserResult, warnings: string[]): AskUserResult {
	if (warnings.length > 0) result.warnings = warnings;
	return result;
}
