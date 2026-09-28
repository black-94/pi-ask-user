import type { AskUserAnswer, NormalizedQuestion } from "./types.ts";

/**
 * A draft answer as manipulated by a UI before being finalized. Selections are
 * option indices; free text is kept verbatim while editing.
 */
export interface DraftAnswer {
	selections: number[];
	freeText: string;
	usedDefault: boolean;
}

export function emptyDraft(): DraftAnswer {
	return { selections: [], freeText: "", usedDefault: false };
}

/** A draft is empty when it carries neither a selection nor any free text. */
export function draftIsEmpty(draft: DraftAnswer): boolean {
	return draft.selections.length === 0 && draft.freeText.trim() === "";
}

/**
 * Materialize the question default as a draft, or `undefined` when the question
 * has no default. A default that matches an option label selects that option;
 * otherwise it is treated as free text (which is what `input` questions want).
 */
export function draftFromDefault(question: NormalizedQuestion): DraftAnswer | undefined {
	if (!question.hasDefault || question.default === undefined) return undefined;
	if (question.kind !== "input") {
		const idx = question.options.findIndex((option) => option.label === question.default!.trim());
		if (idx >= 0) {
			return { selections: [idx], freeText: "", usedDefault: true };
		}
	}
	return { selections: [], freeText: question.default, usedDefault: true };
}

/** Finalize a draft into an answer. Assumes the draft is non-empty. */
export function toAnswer(question: NormalizedQuestion, draft: DraftAnswer): AskUserAnswer {
	const selections = draft.selections
		.filter((idx) => idx >= 0 && idx < question.options.length)
		.map((idx) => question.options[idx]!.label);
	const freeText = draft.freeText.trim();
	const answer: AskUserAnswer = {
		index: question.index,
		id: question.id,
		title: question.title,
		kind: question.kind,
		selections,
		usedDefault: draft.usedDefault,
	};
	if (freeText !== "") answer.freeText = freeText;
	return answer;
}

export interface FinalizeResult {
	answers: AskUserAnswer[];
	/** Indices (0-based question indices) still unanswered and without a default. */
	unanswered: number[];
}

/**
 * Apply defaults to empty drafts and finalize the questionnaire. Questions that
 * are still empty and have no default are reported in `unanswered`; they are
 * omitted from `answers`.
 */
export function finalizeAnswers(questions: NormalizedQuestion[], drafts: DraftAnswer[]): FinalizeResult {
	const answers: AskUserAnswer[] = [];
	const unanswered: number[] = [];
	questions.forEach((question, index) => {
		const draft = drafts[index] ?? emptyDraft();
		if (draftIsEmpty(draft)) {
			const fallback = draftFromDefault(question);
			if (fallback) {
				answers.push(toAnswer(question, fallback));
			} else {
				unanswered.push(index);
			}
			return;
		}
		answers.push(toAnswer(question, draft));
	});
	return { answers, unanswered };
}
