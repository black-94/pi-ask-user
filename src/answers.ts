import type { AskUserAnswer, AskUserFormValue, NormalizedFormField, NormalizedQuestion } from "./types.ts";

/** A UI draft. `valueSet` makes boolean `false` distinct from unanswered. */
export interface DraftAnswer {
	selections: number[];
	freeText: string;
	usedDefault: boolean;
	value?: boolean | AskUserFormValue;
	/** Required to distinguish typed false/empty forms; optional for legacy drafts. */
	valueSet?: boolean;
}

export function emptyDraft(): DraftAnswer {
	return { selections: [], freeText: "", usedDefault: false, valueSet: false };
}

/** A draft is empty only when it contains no legacy or typed value. */
export function draftIsEmpty(draft: DraftAnswer): boolean {
	return !draft.valueSet && draft.selections.length === 0 && draft.freeText.trim() === "";
}

/** Materialize a standalone question default. Forms use per-field defaults. */
export function draftFromDefault(question: NormalizedQuestion): DraftAnswer | undefined {
	if (!question.hasDefault || question.default === undefined) return undefined;
	if (question.kind === "bool") {
		return { selections: [], freeText: "", value: question.default as boolean, valueSet: true, usedDefault: true };
	}
	if (question.kind !== "input") {
		const idx = question.options.findIndex((option) => option.label === String(question.default).trim());
		if (idx >= 0) return { selections: [idx], freeText: "", valueSet: false, usedDefault: true };
	}
	return { selections: [], freeText: String(question.default), valueSet: false, usedDefault: true };
}

/** Finalize a UI draft. Validation is performed separately before acceptance. */
export function toAnswer(question: NormalizedQuestion, draft: DraftAnswer): AskUserAnswer {
	const selections = draft.selections
		.filter((idx) => idx >= 0 && idx < question.options.length)
		.map((idx) => question.options[idx]!.label);
	const answer: AskUserAnswer = {
		index: question.index,
		id: question.id,
		title: question.title,
		kind: question.kind,
		selections,
		usedDefault: draft.usedDefault,
	};
	const freeText = draft.freeText.trim();
	if (freeText !== "") answer.freeText = freeText;
	if (draft.valueSet && draft.value !== undefined) {
		answer.value = typeof draft.value === "object" ? { ...draft.value } : draft.value;
	}
	return answer;
}

export interface FinalizeResult {
	answers: AskUserAnswer[];
	/** Indices (0-based question indices) that fail the normalized contract. */
	unanswered: number[];
}

/** Apply defaults and finalize; required form fields and `false` are handled explicitly. */
export function finalizeAnswers(questions: NormalizedQuestion[], drafts: DraftAnswer[]): FinalizeResult {
	const answers: AskUserAnswer[] = [];
	const unanswered: number[] = [];
	questions.forEach((question, index) => {
		let draft = drafts[index] ?? emptyDraft();
		if (draftIsEmpty(draft)) {
			const fallback = draftFromDefault(question);
			if (fallback) draft = fallback;
		}
		if (draftIsEmpty(draft)) {
			unanswered.push(index);
			return;
		}
		const answer = toAnswer(question, draft);
		if (validateAnswer(question, answer) !== undefined) {
			unanswered.push(index);
			return;
		}
		answers.push(answer);
	});
	return { answers, unanswered };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(record, key);
}

function validateFieldValue(field: NormalizedFormField, value: unknown): string | undefined {
	switch (field.kind) {
		case "bool":
			return typeof value === "boolean" ? undefined : "must be a boolean";
		case "input":
			if (typeof value !== "string") return "must be a string";
			if (field.required && value.trim() === "") return "must not be empty";
			return undefined;
		case "single":
			if (typeof value !== "string") return "must be one option label";
			return field.options.some((option) => option.label === value) ? undefined : "is not an option label";
		case "multi": {
			if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return "must be an array of option labels";
			if (field.required && value.length === 0) return "must contain at least one option";
			if (new Set(value).size !== value.length) return "contains duplicate labels";
			return value.every((entry) => field.options.some((option) => option.label === entry))
				? undefined
				: "contains a label that is not an option";
		}
	}
}

/**
 * Validate a renderer outcome against its exact normalized question. This is
 * the core trust boundary: malformed ids/kinds/options/typed values are never
 * silently accepted as user input.
 */
export function validateAnswer(question: NormalizedQuestion, candidate: unknown): string | undefined {
	if (!isRecord(candidate)) return "answer must be an object";
	const allowedAnswerKeys = ["index", "id", "title", "kind", "selections", "freeText", "usedDefault", "value"];
	const extra = Object.keys(candidate).find((key) => !allowedAnswerKeys.includes(key));
	if (extra) return `answer has unknown field "${extra}"`;
	const answer = candidate as unknown as AskUserAnswer;
	if (answer.index !== question.index || answer.id !== question.id || answer.title !== question.title || answer.kind !== question.kind) {
		return "answer identity does not match the question";
	}
	if (!Array.isArray(answer.selections) || answer.selections.some((entry) => typeof entry !== "string")) return "selections must be strings";
	if (typeof answer.usedDefault !== "boolean") return "usedDefault must be a boolean";
	if (answer.freeText !== undefined && typeof answer.freeText !== "string") return "freeText must be a string";

	if (question.kind === "bool") {
		if (answer.selections.length > 0 || answer.freeText !== undefined) return "bool answers cannot contain selections or freeText";
		return typeof answer.value === "boolean" ? undefined : "bool answer value must be a boolean";
	}
	if (question.kind === "simple-form") {
		if (answer.selections.length > 0 || answer.freeText !== undefined) return "simple-form answers cannot contain selections or freeText";
		if (!isRecord(answer.value)) return "simple-form answer value must be a flat object";
		const prototype = Object.getPrototypeOf(answer.value);
		if (prototype !== Object.prototype && prototype !== null) return "simple-form answer value has an unsafe prototype";
		const fields = question.fields ?? [];
		const allowed = new Map(fields.map((field) => [field.name, field]));
		for (const key of Object.keys(answer.value)) {
			const field = allowed.get(key);
			if (!field) return `simple-form answer has unknown field "${key}"`;
			const invalid = validateFieldValue(field, answer.value[key]);
			if (invalid) return `simple-form field "${key}" ${invalid}`;
		}
		for (const field of fields) {
			if (!field.required) continue;
			if (!hasOwn(answer.value, field.name)) return `simple-form required field "${field.name}" is missing`;
			const invalid = validateFieldValue(field, answer.value[field.name]);
			if (invalid) return `simple-form required field "${field.name}" ${invalid}`;
		}
		return undefined;
	}

	if (answer.value !== undefined) return `${question.kind} answers cannot contain a typed value`;
	if (question.kind === "input") {
		if (answer.selections.length > 0) return "input answers cannot contain selections";
		return (answer.freeText ?? "").trim() === "" ? "input answer is empty" : undefined;
	}
	if (question.allowFreeText === false && answer.freeText !== undefined) return "freeText is disabled for this question";
	if (new Set(answer.selections).size !== answer.selections.length) return "selections contain duplicate labels";
	if (!answer.selections.every((label) => question.options.some((option) => option.label === label))) return "selection is not an option label";
	if (question.kind === "single" && answer.selections.length > 1) return "single answer contains multiple selections";
	return answer.selections.length === 0 && (answer.freeText ?? "").trim() === "" ? "answer is empty" : undefined;
}
