import { Type, type Static } from "typebox";
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
	id: Type.Optional(Type.String({ maxLength: 64 })),
	title: Type.String({ minLength: 1, maxLength: LIMITS.title }),
	prompt: Type.Optional(Type.String({ maxLength: LIMITS.prompt })),
	kind: Type.Optional(StringEnum(["single", "multi", "input"] as const)),
	options: Type.Optional(Type.Array(OptionSchema, { maxItems: MAX_OPTIONS })),
	default: Type.Optional(Type.String({ maxLength: LIMITS.defaultValue })),
});

/** Parameter schema registered for the `AskUserUI` tool. */
export const AskUserUIParams = Type.Object({
	questions: Type.Array(QuestionSchema, { minItems: 1, maxItems: MAX_QUESTIONS }),
	header: Type.Optional(Type.String({ maxLength: LIMITS.header })),
	displayMode: Type.Optional(StringEnum(["overlay", "inline"] as const)),
	timeoutPerQuestionMs: Type.Optional(Type.Number({ minimum: 0 })),
});

export type AskUserUIParamsType = Static<typeof AskUserUIParams>;

export class AskUserValidationError extends Error {
	readonly code = "invalid_request";

	constructor(message: string) {
		super(message);
		this.name = "AskUserValidationError";
	}
}

function asString(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = asString(record[key]);
		if (value !== undefined && value.trim() !== "") return value;
	}
	return undefined;
}

function toKind(value: unknown): QuestionKind | undefined {
	const raw = asString(value)?.trim().toLowerCase();
	if (raw === "single" || raw === "multi" || raw === "input") return raw;
	if (raw === "multiple" || raw === "multiselect" || raw === "multi-select") return "multi";
	if (raw === "text" || raw === "freeform" || raw === "free") return "input";
	return undefined;
}

/** Coerce a model option (string or object with common alias keys) into an option. */
export function coerceOption(value: unknown): AskUserOption | undefined {
	if (typeof value === "string") {
		const label = value.trim();
		return label === "" ? undefined : { label };
	}
	if (!isRecord(value)) return undefined;
	const label = firstString(value, ["label", "title", "value", "text", "name", "option"]);
	if (!label) return undefined;
	const option: AskUserOption = { label };
	const description = firstString(value, ["description", "desc", "detail", "details", "help", "hint"]);
	if (description) option.description = description;
	const preview = firstString(value, ["preview", "markdown", "body", "content"]);
	if (preview) option.preview = preview;
	return option;
}

function coerceQuestion(value: unknown, index: number): { question: AskUserQuestion; warnings: string[] } {
	const warnings: string[] = [];
	if (typeof value === "string") {
		return { question: { title: value.trim(), kind: "input" }, warnings };
	}
	if (!isRecord(value)) {
		throw new AskUserValidationError(`问题 ${index + 1} 不是有效的对象或字符串。`);
	}
	const title = firstString(value, ["title", "question", "header", "label", "text", "prompt"]) ?? "";
	const prompt = firstString(value, ["prompt", "description", "desc", "context", "note", "detail"]);
	const rawOptions = Array.isArray(value.options)
		? value.options
		: Array.isArray(value.choices)
			? value.choices
			: undefined;
	const options = rawOptions ? rawOptions.map(coerceOption).filter((option): option is AskUserOption => !!option) : [];
	if (rawOptions && options.length < rawOptions.length) {
		warnings.push(`问题 ${index + 1} 有 ${rawOptions.length - options.length} 个无效选项被忽略。`);
	}
	let kind = toKind(value.kind) ?? toKind(value.type);
	if (!kind) {
		if (options.length === 0) {
			kind = "input";
		} else {
			const multiple =
				value.allowMultiple === true || value.multiSelect === true || value.multiple === true || value.multi === true;
			kind = multiple ? "multi" : "single";
		}
	}
	const question: AskUserQuestion = { title, kind };
	if (prompt) question.prompt = prompt;
	if (kind !== "input" && options.length > 0) question.options = options;
	const id = firstString(value, ["id"]);
	if (id) question.id = id;
	const defaultValue = firstString(value, ["default", "defaultValue", "default_value", "preset"]);
	if (defaultValue !== undefined) question.default = defaultValue;
	if (kind !== "input" && options.length === 0) {
		warnings.push(`问题 ${index + 1} 是选择题但没有有效选项，已按自由输入处理。`);
		question.kind = "input";
	}
	return { question, warnings };
}

function unwrapQuestions(raw: unknown): unknown[] {
	if (Array.isArray(raw)) return raw;
	if (isRecord(raw)) {
		if (Array.isArray(raw.questions)) return raw.questions;
		if (Array.isArray(raw.items)) return raw.items;
		if (typeof raw.question === "string") return [raw];
	}
	throw new AskUserValidationError("缺少 questions 数组。");
}

/** Normalize arbitrary (usually model-produced) input into a validated request. */
export function normalizeAskUserRequest(raw: unknown): { request: NormalizedRequest; warnings: string[] } {
	const warnings: string[] = [];
	const container = isRecord(raw) ? raw : {};
	const rawQuestions = unwrapQuestions(raw);
	if (rawQuestions.length === 0) {
		throw new AskUserValidationError("至少需要 1 个问题。");
	}
	if (rawQuestions.length > MAX_QUESTIONS) {
		throw new AskUserValidationError(`最多 ${MAX_QUESTIONS} 个问题，收到了 ${rawQuestions.length} 个。`);
	}

	const usedIds = new Set<string>();
	const questions: NormalizedQuestion[] = [];
	rawQuestions.forEach((rawQuestion, index) => {
		const { question, warnings: questionWarnings } = coerceQuestion(rawQuestion, index);
		warnings.push(...questionWarnings);
		const title = question.title.trim();
		if (title === "") {
			throw new AskUserValidationError(`问题 ${index + 1} 缺少 title。`);
		}
		question.title = title.slice(0, LIMITS.title);
		if (question.prompt !== undefined) question.prompt = question.prompt.slice(0, LIMITS.prompt);
		if (question.default !== undefined) question.default = question.default.slice(0, LIMITS.defaultValue);
		if (question.kind !== "input") {
			const rawOptions = question.options ?? [];
			if (rawOptions.length === 0) {
				throw new AskUserValidationError(`问题 “${title}” 是选择题但没有选项。`);
			}
			if (rawOptions.length > MAX_OPTIONS) {
				throw new AskUserValidationError(`每个问题最多 ${MAX_OPTIONS} 个选项（问题 “${title}”）。`);
			}
			const seen = new Set<string>();
			const options: AskUserOption[] = [];
			for (const option of rawOptions) {
				const label = option.label.trim().slice(0, LIMITS.label);
				if (label === "") continue;
				if (seen.has(label)) {
					warnings.push(`问题 “${title}” 有重复选项 “${label}”，已去重。`);
					continue;
				}
				seen.add(label);
				const next: AskUserOption = { label };
				if (option.description) next.description = option.description.slice(0, LIMITS.description);
				if (option.preview) next.preview = option.preview.slice(0, LIMITS.preview);
				options.push(next);
			}
			if (options.length === 0) {
				throw new AskUserValidationError(`问题 “${title}” 没有有效选项。`);
			}
			question.options = options;
		} else {
			delete question.options;
		}

		let id = question.id?.trim() ?? "";
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

	const header = firstString(container, ["header", "title", "heading"]);
	const displayModeRaw = asString(container.displayMode ?? container.display_mode ?? container.mode)?.trim();
	const displayMode: "overlay" | "inline" = displayModeRaw === "inline" ? "inline" : "overlay";

	const perQuestion = Number(container.timeoutPerQuestionMs ?? container.timeout_per_question_ms);
	const timeoutPerQuestionMs =
		Number.isFinite(perQuestion) && perQuestion >= 0 ? Math.floor(perQuestion) : DEFAULT_TIMEOUT_PER_QUESTION_MS;
	// The deadline is always base × questionCount. Any absolute override in the
	// input (e.g. `timeoutMs`) is deliberately ignored so the invariant holds.
	const totalTimeoutMs = timeoutPerQuestionMs * questions.length;

	const request: NormalizedRequest = {
		questions,
		displayMode,
		timeoutPerQuestionMs,
		totalTimeoutMs,
	};
	if (header) request.header = header.slice(0, LIMITS.header);
	return { request, warnings };
}
