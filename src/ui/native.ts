import { draftFromDefault, toAnswer } from "../answers.ts";
import { nativeInputHint, parseNativeAnswer } from "../parse.ts";
import type { AskUIInput, AskUIOutcome, AskUserAnswer, NativeDialogRunner, NormalizedQuestion, NormalizedRequest } from "../types.ts";

/** Minimal shape of the Pi UI context needed by the native route. */
export interface NativeDialogUI {
	input(
		title: string,
		placeholder?: string,
		opts?: { signal?: AbortSignal; timeout?: number },
	): Promise<string | undefined>;
}

function placeholderFor(question: NormalizedQuestion): string {
	switch (question.kind) {
		case "single":
			return question.options.length > 0 ? 'e.g. 2 or "2 | note" or type free text' : "type free text";
		case "multi":
			return question.options.length > 0 ? 'e.g. 1,3 or "1,3 | note" or type free text' : "type free text";
		case "input":
			return "type free text";
	}
}

function buildPrompt(
	request: NormalizedRequest,
	question: NormalizedQuestion,
	invalid: string | undefined,
): string {
	const total = request.questions.length;
	const lines: string[] = [];
	if (request.header && request.header.trim() !== "") lines.push(request.header.trim());
	lines.push(`[Question ${question.index + 1}/${total}] ${question.title}`);
	if (question.prompt && question.prompt.trim() !== "") lines.push(question.prompt.trim());
	question.options.forEach((option, index) => {
		const description = option.description?.trim();
		lines.push(`  ${index + 1}. ${option.label}${description ? ` — ${description}` : ""}`);
	});
	if (question.hasDefault && question.default !== undefined) {
		lines.push(`Default: ${question.default} (press Enter on an empty box to use it)`);
	}
	lines.push(nativeInputHint(question));
	const body = lines.join("\n");
	if (invalid) return `⚠ Invalid input: ${invalid}\n\n${body}`;
	return body;
}

/**
 * The native route: exactly one Pi native input dialog per question. The option
 * number and any trailing free text are typed into the same box. Invalid input
 * re-prompts; the whole questionnaire shares one deadline and each dialog only
 * receives the remaining time.
 */
export function createNativeRunner(ui: NativeDialogUI): NativeDialogRunner {
	return {
		async run({ request, deadline, signal, onUpdate }: AskUIInput): Promise<AskUIOutcome> {
			const answers: AskUserAnswer[] = [];
			const total = request.questions.length;

			for (const question of request.questions) {
				let invalid: string | undefined;
				for (;;) {
					if (deadline.expired()) return { kind: "timeout" };
					onUpdate?.(`Waiting for the user to answer question ${question.index + 1}/${total}…`);
					const remaining = deadline.remainingMs();
					const opts: { signal?: AbortSignal; timeout?: number } = { timeout: remaining };
					if (signal) opts.signal = signal;

					let raw: string | undefined;
					try {
						raw = await ui.input(buildPrompt(request, question, invalid), placeholderFor(question), opts);
					} catch (error) {
						return { kind: "error", message: error instanceof Error ? error.message : String(error) };
					}

					if (raw === undefined) {
						if (deadline.expired()) return { kind: "timeout" };
						if (signal?.aborted) return { kind: "abort" };
						return { kind: "cancelled" };
					}

					const parsed = parseNativeAnswer(question, raw);
					if (!parsed.ok) {
						invalid = parsed.error;
						continue;
					}
					if (parsed.value.empty) {
						const fallback = draftFromDefault(question);
						if (fallback) {
							answers.push(toAnswer(question, fallback));
							break;
						}
						invalid =
							question.kind === "input"
								? "This question is required and cannot be empty."
								: "This question is required; enter an option number or free text.";
						continue;
					}
					answers.push(
						toAnswer(question, {
							selections: parsed.value.selections,
							freeText: parsed.value.freeText ?? "",
							usedDefault: false,
						}),
					);
					break;
				}
			}
			return { kind: "submitted", answers };
		},
	};
}
