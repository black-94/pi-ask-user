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
			return question.options.length > 0 ? "例如 2 或 “2 | 补充说明” 或直接输入文本" : "直接输入文本";
		case "multi":
			return question.options.length > 0 ? "例如 1,3 或 “1,3 | 补充说明” 或直接输入文本" : "直接输入文本";
		case "input":
			return "直接输入文本";
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
	lines.push(`【问题 ${question.index + 1}/${total}】${question.title}`);
	if (question.prompt && question.prompt.trim() !== "") lines.push(question.prompt.trim());
	question.options.forEach((option, index) => {
		const description = option.description?.trim();
		lines.push(`  ${index + 1}. ${option.label}${description ? ` — ${description}` : ""}`);
	});
	if (question.hasDefault && question.default !== undefined) {
		lines.push(`默认值：${question.default}（留空回车即使用默认值）`);
	}
	lines.push(nativeInputHint(question));
	const body = lines.join("\n");
	if (invalid) return `⚠ 输入无效：${invalid}\n\n${body}`;
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
					onUpdate?.(`等待用户回答第 ${question.index + 1}/${total} 题…`);
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
								? "这是必答题，不能为空。"
								: "这是必答题，请输入编号或直接输入文本。";
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
