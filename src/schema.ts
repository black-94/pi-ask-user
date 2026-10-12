import { Type } from "typebox";
import type {
	AskUserOption,
	FormFieldKind,
	NormalizedFormField,
	NormalizedQuestion,
	NormalizedRequest,
	QuestionKind,
} from "./types.ts";

export const MAX_QUESTIONS = 5;
export const MAX_OPTIONS = 5;
export const MAX_FORM_FIELDS = 10;
export const DEFAULT_TIMEOUT_PER_QUESTION_MS = 60_000;

export const LIMITS = {
	title: 200,
	prompt: 500,
	label: 80,
	description: 240,
	preview: 4000,
	defaultValue: 500,
	header: 200,
	fieldName: 64,
} as const;

const ID_MAX_LENGTH = 64;
const QUESTION_KINDS = ["single", "multi", "input", "bool", "simple-form"] as const;
const FIELD_KINDS = ["single", "multi", "input", "bool"] as const;
const QUESTION_FIELDS = ["id", "title", "prompt", "kind", "options", "default", "fields"] as const;
const FORM_FIELD_FIELDS = ["name", "label", "kind", "required", "options", "default"] as const;
const OPTION_FIELDS = ["label", "description", "preview"] as const;
const REQUEST_FIELDS = ["questions", "header", "displayMode", "timeoutPerQuestionMs"] as const;
const SAFE_FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Flat string enum: provider proxies commonly reject unions used only as enums. */
function StringEnum<T extends readonly string[]>(values: T, options: Record<string, unknown> = {}) {
	return Type.Unsafe<T[number]>({ type: "string", enum: [...values], ...options });
}

const OptionSchema = Type.Object({
	label: Type.String({ minLength: 1, maxLength: LIMITS.label }),
	description: Type.Optional(Type.String({ maxLength: LIMITS.description })),
	preview: Type.Optional(Type.String({ maxLength: LIMITS.preview })),
}, { additionalProperties: false });

// Field defaults use three JSON types across the four field kinds. Keep that honest in
// the provider schema; kind-specific membership and type rules are enforced by
// the same direct normalizer used by tool execution.
const FieldDefaultSchema = Type.Union([
	Type.Boolean(),
	Type.String({ maxLength: LIMITS.defaultValue }),
	Type.Array(Type.String({ minLength: 1, maxLength: LIMITS.label }), { maxItems: MAX_OPTIONS }),
]);

const FormFieldSchema = Type.Object({
	name: Type.String({ minLength: 1, maxLength: LIMITS.fieldName, pattern: SAFE_FIELD_NAME.source }),
	label: Type.String({ minLength: 1, maxLength: LIMITS.label }),
	kind: StringEnum(FIELD_KINDS),
	required: Type.Optional(Type.Boolean()),
	options: Type.Optional(Type.Array(OptionSchema, { maxItems: MAX_OPTIONS })),
	default: Type.Optional(FieldDefaultSchema),
}, { additionalProperties: false });

const QuestionSchema = Type.Object({
	id: Type.Optional(Type.String({ minLength: 1, maxLength: ID_MAX_LENGTH })),
	title: Type.String({ minLength: 1, maxLength: LIMITS.title }),
	prompt: Type.Optional(Type.String({ maxLength: LIMITS.prompt })),
	kind: Type.Optional(StringEnum(QUESTION_KINDS)),
	options: Type.Optional(Type.Array(OptionSchema, { maxItems: MAX_OPTIONS })),
	default: Type.Optional(Type.Union([Type.String({ maxLength: LIMITS.defaultValue }), Type.Boolean()])),
	fields: Type.Optional(Type.Array(FormFieldSchema, { minItems: 1, maxItems: MAX_FORM_FIELDS })),
}, { additionalProperties: false });

/** Strict tool/direct-call parameter contract. */
export const AskUserParams = Type.Object({
	questions: Type.Array(QuestionSchema, { minItems: 1, maxItems: MAX_QUESTIONS }),
	header: Type.Optional(Type.String({ maxLength: LIMITS.header })),
	displayMode: Type.Optional(StringEnum(["overlay", "inline"] as const)),
	timeoutPerQuestionMs: Type.Optional(Type.Number({ minimum: 0 })),
}, { additionalProperties: false });

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

function assertKnownKeys(record: Record<string, unknown>, allowed: readonly string[], where: string): void {
	for (const key of Object.keys(record)) {
		if (!allowed.includes(key)) throw new AskUserValidationError(`${where} has an unknown field "${key}".`);
	}
}

function requireText(value: unknown, where: string, maxLength: number): string {
	if (typeof value !== "string") throw new AskUserValidationError(`${where} must be a string.`);
	const text = value.trim();
	if (text === "") throw new AskUserValidationError(`${where} must not be empty.`);
	if (text.length > maxLength) throw new AskUserValidationError(`${where} exceeds the ${maxLength}-character limit.`);
	return text;
}

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

function readOptions(value: unknown, where: string, warnings: string[]): AskUserOption[] {
	if (value !== undefined && !Array.isArray(value)) throw new AskUserValidationError(`${where} "options" must be an array.`);
	const raw = value ?? [];
	if (raw.length > MAX_OPTIONS) throw new AskUserValidationError(`${where} has more than ${MAX_OPTIONS} options.`);
	const options: AskUserOption[] = [];
	const seen = new Set<string>();
	raw.forEach((entry: unknown, position: number) => {
		const option = readOption(entry, where, position);
		if (seen.has(option.label)) {
			warnings.push(`${where} has a duplicate option "${option.label}"; de-duplicated.`);
			return;
		}
		seen.add(option.label);
		options.push(option);
	});
	return options;
}

function readFieldName(value: unknown, where: string): string {
	if (typeof value !== "string") throw new AskUserValidationError(`${where} name must be a string.`);
	if (value.length === 0) throw new AskUserValidationError(`${where} name must not be empty.`);
	if (value.length > LIMITS.fieldName) throw new AskUserValidationError(`${where} name exceeds the ${LIMITS.fieldName}-character limit.`);
	if (!SAFE_FIELD_NAME.test(value)) {
		throw new AskUserValidationError(`${where} name must be a literal key using letters, digits, "_", or "-", and may not contain a path.`);
	}
	if (UNSAFE_OBJECT_KEYS.has(value)) throw new AskUserValidationError(`${where} name "${value}" is reserved and unsafe.`);
	return value;
}

function readFormField(value: unknown, questionWhere: string, position: number, warnings: string[]): NormalizedFormField {
	const where = `${questionWhere} field ${position + 1}`;
	if (!isRecord(value)) throw new AskUserValidationError(`${where} must be an object.`);
	assertKnownKeys(value, FORM_FIELD_FIELDS, where);
	const name = readFieldName(value.name, where);
	const label = requireText(value.label, `${where} label`, LIMITS.label);
	if (typeof value.kind !== "string" || !FIELD_KINDS.includes(value.kind as FormFieldKind)) {
		throw new AskUserValidationError(`${where} "kind" must be "bool", "single", "multi", or "input"; forms cannot nest.`);
	}
	const kind = value.kind as FormFieldKind;
	if (value.required !== undefined && typeof value.required !== "boolean") {
		throw new AskUserValidationError(`${where} "required" must be a boolean.`);
	}
	const required = value.required === true;
	if ((kind === "bool" || kind === "input") && value.options !== undefined) {
		throw new AskUserValidationError(`${where} is a "${kind}" field and must not have "options".`);
	}
	const options = readOptions(value.options, where, warnings);
	if ((kind === "single" || kind === "multi") && options.length === 0) {
		throw new AskUserValidationError(`${where} is a "${kind}" field but has no options.`);
	}

	const field: NormalizedFormField = { name, label, kind, required, options, hasDefault: value.default !== undefined };
	if (value.default === undefined) return field;
	if (kind === "bool") {
		if (typeof value.default !== "boolean") throw new AskUserValidationError(`${where} bool default must be a boolean.`);
		field.default = value.default;
		return field;
	}
	if (kind === "input") {
		if (typeof value.default !== "string") throw new AskUserValidationError(`${where} input default must be a string.`);
		if (value.default.length > LIMITS.defaultValue) throw new AskUserValidationError(`${where} default exceeds the ${LIMITS.defaultValue}-character limit.`);
		if (required && value.default.trim() === "") throw new AskUserValidationError(`${where} required input default must not be empty.`);
		field.default = value.default;
		return field;
	}
	if (kind === "single") {
		if (typeof value.default !== "string") throw new AskUserValidationError(`${where} single default must be an option-label string.`);
		if (!options.some((option) => option.label === value.default)) throw new AskUserValidationError(`${where} default must match one of its option labels.`);
		field.default = value.default;
		return field;
	}
	if (!Array.isArray(value.default)) throw new AskUserValidationError(`${where} multi default must be an array of option-label strings.`);
	if (value.default.length > MAX_OPTIONS) throw new AskUserValidationError(`${where} multi default has more than ${MAX_OPTIONS} labels.`);
	if (required && value.default.length === 0) throw new AskUserValidationError(`${where} required multi default must select at least one label.`);
	const selected: string[] = [];
	for (const [defaultIndex, entry] of value.default.entries()) {
		const labelValue = requireText(entry, `${where} default item ${defaultIndex + 1}`, LIMITS.label);
		if (!options.some((option) => option.label === labelValue)) throw new AskUserValidationError(`${where} default item "${labelValue}" is not an option label.`);
		if (selected.includes(labelValue)) throw new AskUserValidationError(`${where} multi default contains duplicate label "${labelValue}".`);
		selected.push(labelValue);
	}
	field.default = selected;
	return field;
}

interface ParsedQuestion {
	id?: string;
	title: string;
	prompt?: string;
	kind: QuestionKind;
	options: AskUserOption[];
	default?: string | boolean;
	hasDefault: boolean;
	fields: NormalizedFormField[];
}

function readQuestion(value: unknown, index: number): { question: ParsedQuestion; warnings: string[] } {
	const warnings: string[] = [];
	const where = `Question ${index + 1}`;
	if (!isRecord(value)) throw new AskUserValidationError(`${where} must be an object.`);
	assertKnownKeys(value, QUESTION_FIELDS, where);
	const title = requireText(value.title, `${where} title`, LIMITS.title);

	let kind: QuestionKind | undefined;
	if (value.kind !== undefined) {
		if (typeof value.kind !== "string" || !QUESTION_KINDS.includes(value.kind as QuestionKind)) {
			throw new AskUserValidationError(`${where} "kind" must be "single", "multi", "input", "bool", or "simple-form".`);
		}
		kind = value.kind as QuestionKind;
	}
	if ((kind === "bool" || kind === "simple-form") && value.options !== undefined) {
		throw new AskUserValidationError(`${where} is a "${kind}" question and must not have "options".`);
	}
	const options = readOptions(value.options, where, warnings);
	if (kind === undefined) kind = options.length > 0 ? "single" : "input";
	if ((kind === "single" || kind === "multi") && options.length === 0) throw new AskUserValidationError(`${where} is a "${kind}" question but has no options.`);
	if (kind !== "simple-form" && value.fields !== undefined) throw new AskUserValidationError(`${where} is a "${kind}" question and must not have "fields".`);

	const fields: NormalizedFormField[] = [];
	if (kind === "simple-form") {
		if (value.default !== undefined) throw new AskUserValidationError(`${where} simple-form uses field defaults and must not have a top-level "default".`);
		if (!Array.isArray(value.fields)) throw new AskUserValidationError(`${where} simple-form must have a "fields" array.`);
		if (value.fields.length === 0) throw new AskUserValidationError(`${where} simple-form must have at least 1 field.`);
		if (value.fields.length > MAX_FORM_FIELDS) throw new AskUserValidationError(`${where} has more than ${MAX_FORM_FIELDS} fields.`);
		const names = new Set<string>();
		value.fields.forEach((entry, fieldIndex) => {
			const field = readFormField(entry, where, fieldIndex, warnings);
			if (names.has(field.name)) throw new AskUserValidationError(`${where} has duplicate field name "${field.name}".`);
			names.add(field.name);
			fields.push(field);
		});
	} else if (kind === "bool") {
		if (value.default !== undefined && typeof value.default !== "boolean") throw new AskUserValidationError(`${where} bool default must be a boolean.`);
	} else if (value.default !== undefined && typeof value.default !== "string") {
		throw new AskUserValidationError(`${where} default must be a string.`);
	}

	const question: ParsedQuestion = {
		title,
		kind,
		options: kind === "input" ? [] : options,
		hasDefault: value.default !== undefined,
		fields,
	};
	const prompt = optionalText(value.prompt, `${where} prompt`, LIMITS.prompt);
	if (prompt !== undefined) question.prompt = prompt;
	const id = optionalQuestionId(value.id, where);
	if (id) question.id = id;
	if (value.default !== undefined) {
		if (typeof value.default === "string" && value.default.length > LIMITS.defaultValue) throw new AskUserValidationError(`${where} default exceeds the ${LIMITS.defaultValue}-character limit.`);
		question.default = value.default as string | boolean;
	}
	return { question, warnings };
}

function readDisplayMode(value: unknown): "overlay" | "inline" {
	if (value === undefined) return "overlay";
	if (value !== "overlay" && value !== "inline") throw new AskUserValidationError('displayMode must be "overlay" or "inline".');
	return value;
}

function readTimeoutPerQuestionMs(value: unknown): number {
	if (value === undefined) return DEFAULT_TIMEOUT_PER_QUESTION_MS;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new AskUserValidationError("timeoutPerQuestionMs must be a non-negative finite number.");
	return Math.floor(value);
}

/** Normalize and validate a request against the exact tool/direct-call contract. */
export function normalizeAskUserRequest(raw: unknown): { request: NormalizedRequest; warnings: string[] } {
	if (!isRecord(raw)) throw new AskUserValidationError("Missing the questions array.");
	assertKnownKeys(raw, REQUEST_FIELDS, "Request");
	const rawQuestions = raw.questions;
	if (!Array.isArray(rawQuestions)) throw new AskUserValidationError("Missing the questions array.");
	if (rawQuestions.length === 0) throw new AskUserValidationError("At least 1 question is required.");
	if (rawQuestions.length > MAX_QUESTIONS) throw new AskUserValidationError(`At most ${MAX_QUESTIONS} questions; received ${rawQuestions.length}.`);

	const warnings: string[] = [];
	const usedIds = new Set<string>();
	const questions: NormalizedQuestion[] = [];
	rawQuestions.forEach((rawQuestion, index) => {
		const parsed = readQuestion(rawQuestion, index);
		warnings.push(...parsed.warnings);
		const question = parsed.question;
		let id = question.id ?? "";
		if (id === "" || usedIds.has(id)) {
			let candidate = `q${index + 1}`;
			let suffix = 1;
			while (usedIds.has(candidate)) candidate = `q${index + 1}_${suffix++}`;
			id = candidate;
		}
		usedIds.add(id);
		const normalized: NormalizedQuestion = {
			id,
			index,
			title: question.title,
			kind: question.kind,
			options: question.options,
			hasDefault: question.hasDefault,
			fields: question.fields,
		};
		if (question.prompt !== undefined) normalized.prompt = question.prompt;
		if (question.default !== undefined) normalized.default = question.default;
		questions.push(normalized);
	});

	const timeoutPerQuestionMs = readTimeoutPerQuestionMs(raw.timeoutPerQuestionMs);
	const request: NormalizedRequest = {
		questions,
		displayMode: readDisplayMode(raw.displayMode),
		timeoutPerQuestionMs,
		totalTimeoutMs: timeoutPerQuestionMs * questions.length,
	};
	const header = optionalText(raw.header, "header", LIMITS.header);
	if (header !== undefined) request.header = header;
	return { request, warnings };
}
