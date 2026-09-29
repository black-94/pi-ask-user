import type { NormalizedQuestion } from "./types.ts";

/**
 * Parsing of native-dialog answers.
 *
 * The native route uses exactly one Pi native input dialog per question. The
 * number and the optional trailing free text live in the same box:
 *
 *   single:  `2`            `2 | note`        `<free text>`
 *   multi:   `1,3`          `1,3 | note`      `<free text>`
 *   input:   `<free text>`
 *
 * The left-hand side of the first `|` is classified as an option-number list or
 * as free text. The rules are deliberately strict so a malformed number list is
 * re-prompted instead of being silently treated as prose:
 *
 *  1. If the left side contains only digits and separators (` ` `,` `，` `、`),
 *     it is an option-number list. Tokens are validated for range and count.
 *  2. Otherwise, if the left side begins with a digit run immediately followed by
 *     a list separator (`,` `，` `、` `.`) — e.g. `1,a`, `1.5`, `2, please` — it is
 *     a malformed option-number list and is rejected, not guessed as free text.
 *  3. Otherwise the whole input is free text. This covers prose such as
 *     `2 options please` (a space after the digit, not a list separator).
 *
 * To answer with prose that starts like a number list, write it after an empty
 * left side: `| 1, please explain`. An empty left side always means free input.
 */

export interface ParsedAnswer {
	selections: number[];
	freeText?: string;
	empty: boolean;
}

export type ParseOutcome = { ok: true; value: ParsedAnswer } | { ok: false; error: string };

const PURE_DIGITS = /^\d+$/;
/** digits + separators only (spaces, ASCII/CJK commas, enumeration comma). */
const DIGIT_SEPARATOR_ONLY = /^[\d\s,\uFF0C\u3001]+$/;
/** a digit run immediately followed by a list separator ⇒ a number-list attempt. */
const NUMBER_LIST_ATTEMPT = /^\d+\s*[.,\uFF0C\u3001]/;

function splitOnSeparators(value: string): string[] {
	return value.split(/[,\uFF0C\u3001\s]+/).filter((token) => token.length > 0);
}

export function parseNativeAnswer(question: NormalizedQuestion, raw: string): ParseOutcome {
	const trimmed = raw.trim();
	if (trimmed === "") {
		return { ok: true, value: { selections: [], empty: true } };
	}

	// Free-text-only questions take the whole box verbatim.
	if (question.kind === "input") {
		return { ok: true, value: { selections: [], freeText: trimmed, empty: false } };
	}

	const pipeIndex = raw.indexOf("|");
	const left = pipeIndex >= 0 ? raw.slice(0, pipeIndex) : raw;
	const right = pipeIndex >= 0 ? raw.slice(pipeIndex + 1) : "";
	const comment = right.trim();
	const leftTrim = left.trim();

	// No number in the box: the (optional) right side is the free input.
	if (leftTrim === "") {
		return { ok: true, value: { selections: [], freeText: comment, empty: comment === "" } };
	}

	const isStrictList = DIGIT_SEPARATOR_ONLY.test(leftTrim);
	const isListAttempt = isStrictList || NUMBER_LIST_ATTEMPT.test(leftTrim);
	if (!isListAttempt) {
		// Free text, taken verbatim including any `|`.
		return { ok: true, value: { selections: [], freeText: trimmed, empty: false } };
	}

	// Tokens are separated only by commas/spaces; a stray character such as `.`
	// or a letter makes the whole thing an invalid number list (re-prompt).
	const tokens = splitOnSeparators(leftTrim);
	const bad = tokens.find((token) => !PURE_DIGITS.test(token));
	if (bad !== undefined || tokens.length === 0) {
		return { ok: false, error: `Invalid number: "${leftTrim}" is not a valid option-number list.` };
	}

	const indices = tokens.map((token) => Number.parseInt(token, 10) - 1);
	const max = question.options.length;
	const outOfRange = indices.find((idx) => idx < 0 || idx >= max);
	if (outOfRange !== undefined) {
		return { ok: false, error: `Number out of range: enter a number between 1 and ${max}.` };
	}

	const unique = [...new Set(indices)];
	if (question.kind === "single" && unique.length > 1) {
		return { ok: false, error: "This is a single-select question; enter only one number." };
	}

	const ordered = question.kind === "single" ? unique : [...unique].sort((a, b) => a - b);
	const value: ParsedAnswer = {
		selections: question.kind === "single" ? [ordered[0]!] : ordered,
		empty: false,
	};
	if (comment !== "") value.freeText = comment;
	return { ok: true, value };
}

/** Render the per-question input instruction used by the native route. */
export function nativeInputHint(question: NormalizedQuestion): string {
	switch (question.kind) {
		case "single":
			return question.options.length > 0
				? 'Single select. Reply with a number (e.g. 2), or "2 | note", or just reply with free text.'
				: "Free input. Reply with text to answer.";
		case "multi":
			return question.options.length > 0
				? 'Multi select. Reply with numbers separated by commas (e.g. 1,3), or "1,3 | note", or just reply with free text.'
				: "Free input. Reply with text to answer.";
		case "input":
			return "Free input. Reply with text to answer.";
	}
}
