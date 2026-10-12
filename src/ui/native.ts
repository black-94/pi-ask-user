import { draftFromDefault, toAnswer } from "../answers.ts";
import { nativeInputHint, parseNativeAnswer } from "../parse.ts";
import type {
	AskUIInput,
	AskUIOutcome,
	AskUserAnswer,
	AskUserFormValue,
	NativeDialogRunner,
	NormalizedFormField,
	NormalizedQuestion,
	NormalizedRequest,
} from "../types.ts";

export interface NativeDialogOptions {
	signal?: AbortSignal;
	timeout?: number;
}

/** Native select is required for typed controls when allowFreeText is false. */
export interface NativeDialogUI {
	input(title: string, placeholder?: string, opts?: NativeDialogOptions): Promise<string | undefined>;
	select?(title: string, options: string[], opts?: NativeDialogOptions): Promise<string | undefined>;
}

function placeholderFor(question: NormalizedQuestion): string {
	if (question.allowFreeText === false && (question.kind === "single" || question.kind === "multi")) {
		return question.kind === "single" ? "one option number, e.g. 2" : "option numbers, e.g. 1,3";
	}
	switch (question.kind) {
		case "single": return 'e.g. 2 or "2 | note" or type free text';
		case "multi": return 'e.g. 1,3 or "1,3 | note" or type free text';
		case "input": return "type free text";
		case "bool": return "true or false";
		case "simple-form": return "complete each field";
	}
}

function buildPrompt(request: NormalizedRequest, question: NormalizedQuestion, invalid: string | undefined, typed = false): string {
	const lines: string[] = [];
	if (request.header?.trim()) lines.push(request.header.trim());
	lines.push(`[Question ${question.index + 1}/${request.questions.length}] ${question.title}`);
	if (question.prompt?.trim()) lines.push(question.prompt.trim());
	question.options.forEach((option, index) => {
		const description = option.description?.trim();
		lines.push(`  ${index + 1}. ${option.label}${description ? ` — ${description}` : ""}`);
	});
	if (question.hasDefault && question.default !== undefined) lines.push(`Default: ${String(question.default)}${typed ? "" : " (empty box uses it)"}`);
	if (!typed) lines.push(nativeInputHint(question));
	const body = lines.join("\n");
	return invalid ? `⚠ Invalid input: ${invalid}\n\n${body}` : body;
}

function fieldPlaceholder(field: NormalizedFormField): string {
	switch (field.kind) {
		case "bool": return "true or false";
		case "single": return "one option number";
		case "multi": return "option numbers, e.g. 1,3";
		case "input": return field.required ? "type a value" : "empty skips this optional field";
	}
}

function buildFieldPrompt(
	request: NormalizedRequest,
	question: NormalizedQuestion,
	field: NormalizedFormField,
	fieldIndex: number,
	invalid: string | undefined,
	typed = false,
): string {
	const lines: string[] = [];
	if (request.header?.trim()) lines.push(request.header.trim());
	lines.push(`[Question ${question.index + 1}/${request.questions.length} · Field ${fieldIndex + 1}/${question.fields?.length ?? 0}] ${question.title}`);
	if (question.prompt?.trim()) lines.push(question.prompt.trim());
	lines.push(`${field.label}${field.required ? " (required)" : " (optional)"}`);
	field.options.forEach((option, index) => {
		const description = option.description?.trim();
		lines.push(`  ${index + 1}. ${option.label}${description ? ` — ${description}` : ""}`);
	});
	if (field.hasDefault) lines.push(`Default: ${Array.isArray(field.default) ? field.default.join(", ") : String(field.default)}${typed ? "" : " (empty box uses it)"}`);
	if (typed) return lines.join("\n");
	if (field.kind === "bool") lines.push("Enter exactly true or false (case-insensitive).");
	else if (field.kind === "single") lines.push("Enter exactly one option number; arbitrary text is not accepted in a form.");
	else if (field.kind === "multi") lines.push("Enter option numbers separated by commas/spaces; arbitrary text is not accepted in a form.");
	else lines.push(field.required ? "Enter text." : "Enter text, or leave empty to omit this field.");
	const body = lines.join("\n");
	return invalid ? `⚠ Invalid input: ${invalid}\n\n${body}` : body;
}

type TypedParse = { ok: true; value: boolean | string | string[] } | { ok: false; error: string };

function parseFormField(field: NormalizedFormField, raw: string): TypedParse {
	const text = raw.trim();
	if (field.kind === "input") return { ok: true, value: text };
	if (field.kind === "bool") {
		if (text.toLowerCase() === "true") return { ok: true, value: true };
		if (text.toLowerCase() === "false") return { ok: true, value: false };
		return { ok: false, error: "Enter exactly true or false." };
	}
	if (!/^[\d\s,\uFF0C\u3001]+$/.test(text)) return { ok: false, error: "Enter option numbers only." };
	const tokens = text.split(/[,\uFF0C\u3001\s]+/).filter(Boolean);
	const indices = tokens.map((token) => Number.parseInt(token, 10) - 1);
	if (indices.some((index) => !Number.isInteger(index) || index < 0 || index >= field.options.length)) {
		return { ok: false, error: `Number out of range: enter ${field.kind === "single" ? "one number" : "numbers"} between 1 and ${field.options.length}.` };
	}
	const unique = [...new Set(indices)];
	if (field.kind === "single") {
		if (unique.length !== 1) return { ok: false, error: "This field accepts exactly one option number." };
		return { ok: true, value: field.options[unique[0]!]!.label };
	}
	return { ok: true, value: unique.sort((a, b) => a - b).map((index) => field.options[index]!.label) };
}

function cloneDefault(value: boolean | string | string[]): boolean | string | string[] {
	return Array.isArray(value) ? [...value] : value;
}

/** Sequential native dialogs with one shared questionnaire deadline. */
export function createNativeRunner(ui: NativeDialogUI): NativeDialogRunner {
	return {
		async run({ request, deadline, signal, onUpdate }: AskUIInput): Promise<AskUIOutcome> {
			const answers: AskUserAnswer[] = [];
			const usesTypedControl = (question: NormalizedQuestion): boolean =>
				question.kind !== "input" && question.kind !== "multi" && (request.allowFreeText === false || question.allowFreeText === false);
			// Refuse before showing any dialogs; never substitute text input for a missing selector.
			const needsSelect = request.questions.some((question) => usesTypedControl(question) &&
				(question.kind !== "simple-form" || question.fields?.some((field) => field.kind === "bool" || field.kind === "single")));
			if (needsSelect && typeof ui.select !== "function") {
				return { kind: "error", message: "allowFreeText=false requires native select dialogs, but this host does not provide ui.select. No text-input fallback was used." };
			}
			const dialog = async (invoke: (opts: NativeDialogOptions) => Promise<string | undefined>): Promise<{ raw?: string; outcome?: AskUIOutcome }> => {
				if (signal?.aborted) return { outcome: { kind: "abort" } };
				if (deadline.expired()) return { outcome: { kind: "timeout" } };
				const opts: { signal?: AbortSignal; timeout?: number } = { timeout: deadline.remainingMs() };
				if (signal) opts.signal = signal;
				try {
					const raw = await invoke(opts);
					if (signal?.aborted) return { outcome: { kind: "abort" } };
					if (deadline.expired()) return { outcome: { kind: "timeout" } };
					if (raw !== undefined) return { raw };
					return { outcome: { kind: "cancelled" } };
				} catch (error) {
					if (signal?.aborted) return { outcome: { kind: "abort" } };
					if (deadline.expired()) return { outcome: { kind: "timeout" } };
					return { outcome: { kind: "error", message: error instanceof Error ? error.message : String(error) } };
				}
			};

			const ask = (title: string, placeholder: string) => dialog((opts) => ui.input(title, placeholder, opts));
			const select = (title: string, options: string[]) => dialog((opts) => ui.select!(title, options, opts));
			const typedField = async (title: string, field: NormalizedFormField): Promise<{
				value?: boolean | string | string[]; usedDefault?: boolean; outcome?: AskUIOutcome;
			}> => {
				const options = field.kind === "bool" ? ["✓ True", "✗ False"] : field.options.map((option, index) =>
					`${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`);
				const defaultOption = `Use default: ${String(field.default)}`;
				const skip = "Skip optional field";
				const response = await select(title, [
					...options, ...(field.hasDefault ? [defaultOption] : []), ...(!field.required ? [skip] : []),
				]);
				if (response.outcome) return { outcome: response.outcome };
				if (field.hasDefault && response.raw === defaultOption) return { value: cloneDefault(field.default!), usedDefault: true };
				if (!field.required && response.raw === skip) return {};
				const index = options.indexOf(response.raw!);
				if (index < 0) return { outcome: { kind: "error", message: "Native select returned an unknown option." } };
				return { value: field.kind === "bool" ? index === 0 : field.options[index]!.label, usedDefault: false };
			};

			for (const question of request.questions) {
				if (question.kind === "simple-form") {
					const value: AskUserFormValue = {};
					let usedDefault = false;
					const fields = question.fields ?? [];
					for (let fieldIndex = 0; fieldIndex < fields.length; fieldIndex += 1) {
						const field = fields[fieldIndex]!;
						if (usesTypedControl(question) && (field.kind === "bool" || field.kind === "single")) {
							onUpdate?.(`Waiting for the user to answer question ${question.index + 1}/${request.questions.length}, field ${fieldIndex + 1}/${fields.length}…`);
							const response = await typedField(buildFieldPrompt(request, question, field, fieldIndex, undefined, true), field);
							if (response.outcome) return response.outcome;
							if (response.value !== undefined) value[field.name] = response.value;
							usedDefault ||= response.usedDefault === true;
							continue;
						}
						let invalid: string | undefined;
						for (;;) {
							onUpdate?.(`Waiting for the user to answer question ${question.index + 1}/${request.questions.length}, field ${fieldIndex + 1}/${fields.length}…`);
							const response = await ask(buildFieldPrompt(request, question, field, fieldIndex, invalid), fieldPlaceholder(field));
							if (response.outcome) return response.outcome;
							const raw = response.raw!;
							if (raw.trim() === "") {
								if (field.hasDefault && field.default !== undefined) {
									value[field.name] = cloneDefault(field.default);
									usedDefault = true;
									break;
								}
								if (!field.required) break;
								invalid = "This field is required and cannot be skipped.";
								continue;
							}
							const parsed = parseFormField(field, raw);
							if (!parsed.ok) {
								invalid = parsed.error;
								continue;
							}
							if (field.required && ((typeof parsed.value === "string" && parsed.value.trim() === "") || (Array.isArray(parsed.value) && parsed.value.length === 0))) {
								invalid = "This field is required and cannot be empty.";
								continue;
							}
							value[field.name] = parsed.value;
							break;
						}
					}
					answers.push({ index: question.index, id: question.id, title: question.title, kind: question.kind, selections: [], usedDefault, value });
					continue;
				}

				if (usesTypedControl(question)) {
					onUpdate?.(`Waiting for the user to answer question ${question.index + 1}/${request.questions.length}…`);
					const field: NormalizedFormField = {
						name: question.id, label: question.title, kind: question.kind as "bool" | "single",
						required: true, options: question.options, hasDefault: question.hasDefault,
						default: typeof question.default === "string" ? question.default.trim() : question.default,
					};
					const response = await typedField(buildPrompt(request, question, undefined, true), field);
					if (response.outcome) return response.outcome;
					const selections = question.kind === "bool" ? [] : question.options
						.map((option, index) => ({ option, index }))
						.filter(({ option }) => response.value === option.label)
						.map(({ index }) => index);
					answers.push(toAnswer(question, {
						selections, freeText: "", usedDefault: response.usedDefault === true,
						...(question.kind === "bool" ? { value: response.value as boolean, valueSet: true } : {}),
					}));
					continue;
				}

				let invalid: string | undefined;
				for (;;) {
					onUpdate?.(`Waiting for the user to answer question ${question.index + 1}/${request.questions.length}…`);
					const response = await ask(buildPrompt(request, question, invalid), placeholderFor(question));
					if (response.outcome) return response.outcome;
					const raw = response.raw!;
					if (question.kind === "bool") {
						if (raw.trim() === "") {
							const fallback = draftFromDefault(question);
							if (fallback) {
								answers.push(toAnswer(question, fallback));
								break;
							}
							invalid = "This boolean is required; enter true or false.";
							continue;
						}
						const lower = raw.trim().toLowerCase();
						if (lower !== "true" && lower !== "false") {
							invalid = "Enter exactly true or false.";
							continue;
						}
						answers.push(toAnswer(question, { selections: [], freeText: "", usedDefault: false, value: lower === "true", valueSet: true }));
						break;
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
						invalid = question.kind === "input" ? "This question is required and cannot be empty."
							: question.allowFreeText === false ? "This question is required; enter option numbers only."
							: "This question is required; enter an option number or free text.";
						continue;
					}
					answers.push(toAnswer(question, { selections: parsed.value.selections, freeText: parsed.value.freeText ?? "", usedDefault: false, valueSet: false }));
					break;
				}
			}
			return { kind: "submitted", answers };
		},
	};
}
