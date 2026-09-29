import { Type } from "typebox";
import type { AskUserOption, AskUserQuestion, NormalizedQuestion, NormalizedRequest, QuestionKind } from "./types.ts";

export const MAX_QUESTIONS = 5;
export const MAX_OPTIONS = 5;
export const DEFAULT_TIMEOUT_PER_QUESTION_MS = 60_000;

export const LIMITS = {
	title: 200,
	prompt: 500,
	label: 80,
	description: 240,
	preview: 4000,
	defaultValue: 500,
	header: 200,
} as const;

const ID_MAX_LENGTH = 64;
const QUESTION_KINDS = ["single", "multi", "input"] as const;
const QUESTION_FIELDS = ["id", "title", "prompt", "kind", "options", "default"] as const;
const OPTION_FIELDS = ["label", "description", "preview"] as const;
const REQUEST_FIELDS = ["questions", "header", "displayMode", "timeoutPerQuestionMs"] as const;

/**
 * Flat string enum. Emitted as `{ type: "string", enum: [...] }` because some
 * provider proxies reject `anyOf`/`union` shapes.
 */
function StringEnum<T extends readonly string[]>(values: T, options: Record<string, unknown> = {}) {
	return Type.Unsafe<T[number]>({ type: "string", enum: [...values], ...options });
}

const OptionSchema = Type.Object({
	label: Type.String({ minLength: 1, maxLength: LIMITS.label }),
	description: Type.Optional(Type.String({ maxLength: LIMITS.description })),
	preview: Type.Optional(Type.String({ maxLength: LIMITS.preview })),
});

const QuestionSchema = Type.Object({
	id: Type.Optional(Type.String({ minLength: 1, maxLength: ID_MAX_LENGTH })),
	title: Type.String({ minLength: 1, maxLength: LIMITS.title }),
	prompt: Type.Optional(Type.String({ maxLength: LIMITS.prompt })),
	kind: Type.Optional(StringEnum(QUESTION_KINDS)),
	options: Type.Optional(Type.Array(OptionSchema, { maxItems: MAX_OPTIONS })),
	default: Type.Optional(Type.String({ maxLength: LIMITS.defaultValue })),
});

/**
 * Parameter schema registered for the `AskUser` tool, and the single input
 * contract for direct `askUser` calls too. Only these fields and types are read;
 * anything else is rejected as `invalid_request` rather than coerced.
 *
 * The UI route is host configuration, resolved by the host adapter — it is never
 * part of a request.
 */
export const AskUserParams = Type.Object({
	questions: Type.Array(QuestionSchema, { minItems: 1, maxItems: MAX_QUESTIONS }),
	header: Type.Optional(Type.String({ maxLength: LIMITS.header })),
	displayMode: Type.Optional(StringEnum(["overlay", "inline"] as const)),
	timeoutPerQuestionMs: Type.Optional(Type.Number({ minimum: 0 })),
});

export class AskUserValidationError extends Error {
	readonly code = "invalid_request";

	constructor(message: string) {
		super(message);
		this.name = "AskUserValidationError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reject any field that is not part of the declared contract. */
function assertKnownKeys(record: Record<string, unknown>, allowed: readonly string[], where: string): void {
	for (const key of Object.keys(record)) {
		if (!allowed.includes(key)) throw new AskUserValidationError(`${where} has an unknown field "${key}".`);
	}
}

/** A required, non-empty, length-bounded string; returns the trimmed value. */
function requireText(value: unknown, where: string, maxLength: number): string {
	if (typeof value !== "string") throw new AskUserValidationError(`${where} must be a string.`);
	const text = value.trim();
	if (text === "") throw new AskUserValidationError(`${where} must not be empty.`);
	if (text.length > maxLength) throw new AskUserValidationError(`${where} exceeds the ${maxLength}-character limit.`);
	return text;
}

/** An optional, length-bounded string; absent stays absent. */
function optionalText(value: unknown, where: string, maxLength: number): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new AskUserValidationError(`${where} must be a string.`);
	if (value.length > maxLength) throw new AskUserValidationError(`${where} exceeds the ${maxLength}-character limit.`);
	return value;
}

function optionalQuestionId(value: unknown, where: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new AskUserValidationError(`${where} "id" must be a string.`);
	const id = value.trim();
	if (id === "") throw new AskUserValidationError(`${where} "id" must not be empty.`);
	if (id.length > ID_MAX_LENGTH) throw new AskUserValidationError(`${where} "id" exceeds the ${ID_MAX_LENGTH}-character limit.`);
	return id;
}

/** A canonical option object: `{ label, description?, preview? }`. */
function readOption(value: unknown, where: string, position: number): AskUserOption {
	const at = `${where} option ${position + 1}`;
	if (!isRecord(value)) throw new AskUserValidationError(`${at} must be an object with a "label".`);
	assertKnownKeys(value, OPTION_FIELDS, at);
	const label = requireText(value.label, `${at} label`, LIMITS.label);
	const option: AskUserOption = { label };
	const description = optionalText(value.description, `${at} description`, LIMITS.description);
	if (description !== undefined) option.description = description;
	const preview = optionalText(value.preview, `${at} preview`, LIMITS.preview);
	if (preview !== undefined) option.preview = preview;
	return option;
}

function readQuestion(value: unknown, index: number): { question: AskUserQuestion; warnings: string[] } {
	const warnings: string[] = [];
	const where = `Question ${index + 1}`;
	if (!isRecord(value)) throw new AskUserValidationError(`${where} must be an object.`);
	assertKnownKeys(value, QUESTION_FIELDS, where);

	const title = requireText(value.title, `${where} title`, LIMITS.title);

	let kind: QuestionKind | undefined;
	if (value.kind !== undefined) {
		if (typeof value.kind !== "string" || !QUESTION_KINDS.includes(value.kind as QuestionKind)) {
			throw new AskUserValidationError(`${where} "kind" must be "single", "multi", or "input".`);
		}
		kind = value.kind as QuestionKind;
	}

	const rawOptions = value.options;
	if (rawOptions !== undefined && !Array.isArray(rawOptions)) {
		throw new AskUserValidationError(`${where} "options" must be an array.`);
	}
	const rawOptionList = rawOptions ?? [];
	if (rawOptionList.length > MAX_OPTIONS) {
		throw new AskUserValidationError(`${where} has more than ${MAX_OPTIONS} options.`);
	}

	const options: AskUserOption[] = [];
	const seen = new Set<string>();
	rawOptionList.forEach((rawOption, position) => {
		const option = readOption(rawOption, where, position);
		if (seen.has(option.label)) {
			warnings.push(`${where} has a duplicate option "${option.label}"; de-duplicated.`);
			return;
		}
		seen.add(option.label);
		options.push(option);
	});

	// When `kind` is omitted it is inferred from `options`: present ⇒ `single`,
	// absent ⇒ `input`. `multi` is only ever explicit.
	if (kind === undefined) kind = options.length > 0 ? "single" : "input";
	if (kind !== "input" && options.length === 0) {
		throw new AskUserValidationError(`${where} is a "${kind}" question but has no options.`);
	}

	const question: AskUserQuestion = { title, kind };
	const prompt = optionalText(value.prompt, `${where} prompt`, LIMITS.prompt);
	if (prompt !== undefined) question.prompt = prompt;
	if (kind === "input") {
		delete question.options;
	} else {
		question.options = options;
	}
	const id = optionalQuestionId(value.id, where);
	if (id) question.id = id;
	const fallback = optionalText(value.default, `${where} default`, LIMITS.defaultValue);
	if (fallback !== undefined) question.default = fallback;
	return { question, warnings };
}

function readDisplayMode(value: unknown): "overlay" | "inline" {
	if (value === undefined) return "overlay";
	if (value !== "overlay" && value !== "inline") {
		throw new AskUserValidationError('displayMode must be "overlay" or "inline".');
	}
	return value;
}

function readTimeoutPerQuestionMs(value: unknown): number {
	if (value === undefined) return DEFAULT_TIMEOUT_PER_QUESTION_MS;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new AskUserValidationError("timeoutPerQuestionMs must be a non-negative finite number.");
	}
	return Math.floor(value);
}

/** Normalize and validate a request against the {@link AskUserParams} contract. */
export function normalizeAskUserRequest(raw: unknown): { request: NormalizedRequest; warnings: string[] } {
	if (!isRecord(raw)) throw new AskUserValidationError("Missing the questions array.");
	for (const key of Object.keys(raw)) {
		if (!REQUEST_FIELDS.includes(key as (typeof REQUEST_FIELDS)[number])) {
			throw new AskUserValidationError(`Unknown field "${key}".`);
		}
	}
	const rawQuestions = raw.questions;
	if (!Array.isArray(rawQuestions)) throw new AskUserValidationError("Missing the questions array.");
	if (rawQuestions.length === 0) throw new AskUserValidationError("At least 1 question is required.");
	if (rawQuestions.length > MAX_QUESTIONS) {
		throw new AskUserValidationError(`At most ${MAX_QUESTIONS} questions; received ${rawQuestions.length}.`);
	}

	const warnings: string[] = [];
	const usedIds = new Set<string>();
	const questions: NormalizedQuestion[] = [];
	rawQuestions.forEach((rawQuestion, index) => {
		const { question, warnings: questionWarnings } = readQuestion(rawQuestion, index);
		warnings.push(...questionWarnings);

		let id = question.id ?? "";
		if (id === "" || usedIds.has(id)) {
			let candidate = `q${index + 1}`;
			let suffix = 1;
			while (usedIds.has(candidate)) {
				candidate = `q${index + 1}_${suffix++}`;
			}
			id = candidate;
		}
		usedIds.add(id);

		const normalized: NormalizedQuestion = {
			id,
			index,
			title: question.title,
			kind: question.kind,
			options: question.options ?? [],
			hasDefault: question.default !== undefined,
		};
		if (question.prompt !== undefined) normalized.prompt = question.prompt;
		if (question.default !== undefined) normalized.default = question.default;
		questions.push(normalized);
	});

	const header = optionalText(raw.header, "header", LIMITS.header);
	const displayMode = readDisplayMode(raw.displayMode);
	const timeoutPerQuestionMs = readTimeoutPerQuestionMs(raw.timeoutPerQuestionMs);

	const request: NormalizedRequest = {
		questions,
		displayMode,
		timeoutPerQuestionMs,
		totalTimeoutMs: timeoutPerQuestionMs * questions.length,
	};
	if (header !== undefined) request.header = header;
	return { request, warnings };
}
