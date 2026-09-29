import {
	Input,
	Key,
	Markdown,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { Component, Focusable, MarkdownTheme } from "@earendil-works/pi-tui";
import { draftFromDefault, draftIsEmpty, emptyDraft, finalizeAnswers, type DraftAnswer } from "../answers.ts";
import type { AskUserAnswer, Deadline, NormalizedQuestion, NormalizedRequest } from "../types.ts";

/** Structural theme surface the component needs (a real Pi Theme satisfies it). */
export interface AskUserTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
	italic?(text: string): string;
	underline?(text: string): string;
	strikethrough?(text: string): string;
	inverse?(text: string): string;
}

export interface AskUserTUI {
	requestRender(): void;
	terminal?: { rows?: number; columns?: number };
}

export interface CustomUIResult {
	kind: "submitted" | "cancelled" | "timeout" | "abort" | "error";
	answers?: AskUserAnswer[];
	message?: string;
}

export interface AskUserComponentOptions {
	request: NormalizedRequest;
	deadline: Deadline;
	theme: AskUserTheme;
	tui: AskUserTUI;
	done: (result: CustomUIResult) => void;
	/**
	 * Overlay show/hide key spec (for example `alt+o`), when the custom overlay
	 * registered one. Shown in the key hints so the shortcut is discoverable.
	 * `undefined` means the toggle is disabled or the route is inline.
	 */
	overlayToggleKey?: string;
}

/** Terminal/pane width at or above which the preview gets its own column. */
export const SPLIT_MIN_WIDTH = 90;
/**
 * Rows needed for the full fixed chrome — title + free-input row + key hints.
 * When the terminal is shorter, rows are dropped in this order: title, then
 * hints, always keeping the free-input row while at least one row remains. With
 * zero rows nothing is rendered. Below 3 rows the question title or the key
 * hints may be missing, but `Esc` always cancels and the input stays operable.
 */
export const MIN_USABLE_ROWS = 3;
const COLUMN_GAP = 2;
const MIN_LEFT = 30;
const MIN_PREVIEW = 24;
const MAX_BODY_RATIO = 0.85;
const DEFAULT_ROWS = 24;
const TAB_LABEL_WIDTH = 14;
const DESCRIPTION_INDENT = "       ";
const MAX_TITLE_LINES = 2;
const MAX_PROMPT_LINES = 3;
const MAX_NOTICE_LINES = 2;
/** Keep short overlays prominent without consuming the whole terminal. */
export const MIN_OVERLAY_ROWS = 14;
const OVERLAY_MAX_HEIGHT_RATIO = 0.85;
const OVERLAY_MARGIN = 1;

function buildMarkdownTheme(theme: AskUserTheme): MarkdownTheme {
	const color = (name: string) => (text: string) => theme.fg(name, text);
	return {
		heading: (text) => theme.bold(theme.fg("mdHeading", text)),
		link: color("mdLink"),
		linkUrl: color("mdLinkUrl"),
		code: color("mdCode"),
		codeBlock: color("mdCodeBlock"),
		codeBlockBorder: color("mdCodeBlockBorder"),
		quote: color("mdQuote"),
		quoteBorder: color("mdQuoteBorder"),
		hr: color("mdHr"),
		listBullet: color("mdListBullet"),
		bold: (text) => theme.bold(text),
		italic: (text) => (theme.italic ? theme.italic(text) : text),
		strikethrough: (text) => (theme.strikethrough ? theme.strikethrough(text) : text),
		underline: (text) => (theme.underline ? theme.underline(text) : text),
	};
}

function placeholderFor(question: NormalizedQuestion): string {
	if (question.kind === "input") return "Type your answer";
	if (question.hasDefault) return "Optional: add a note, or press Enter to use the default";
	return "Optional: add a note";
}

function clamp(value: number, min: number, max: number): number {
	if (max < min) return min;
	return Math.max(min, Math.min(max, value));
}

/**
 * Return printable text for key input, or `undefined` for control keys and
 * escape sequences. Multi-character paste payloads count as printable.
 */
function printableText(data: string): string | undefined {
	if (data === "" || data.startsWith("\x1b")) return undefined;
	for (const char of data) {
		const code = char.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) return undefined;
	}
	return data;
}

/**
 * Custom terminal UI for AskUser.
 *
 * Layout: a fixed title/tabs/prompt/notice header, a scrollable body (options,
 * and the preview either in a right column or stacked below), a **pinned free
 * input row**, and a fixed key-hint row. The input row is never scrolled out of
 * view, so no matter how long the option descriptions or preview are the user can
 * always see and reach the free-input entry point.
 *
 * The whole questionnaire shares one deadline; no route degrades on cancel,
 * timeout, or failure. `render(width)` never exceeds the requested width, and
 * the total height never exceeds `terminal.rows` (see {@link MIN_USABLE_ROWS} for
 * the documented degradation below the minimum).
 */
export class AskUserComponent implements Component, Focusable {
	private readonly request: NormalizedRequest;
	private readonly deadline: Deadline;
	private readonly theme: AskUserTheme;
	private readonly tui: AskUserTUI;
	private readonly done: (result: CustomUIResult) => void;
	private readonly drafts: DraftAnswer[];
	private readonly cursors: number[];
	private readonly inputs: Input[];
	private readonly mdTheme: MarkdownTheme;
	private readonly overlayToggleKey: string | undefined;
	private readonly previewCache = new Map<string, Markdown>();

	private tab = 0;
	private reviewButtonFocused = false;
	private notice: string | undefined;
	private finished = false;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private countdownTick: ReturnType<typeof setInterval> | undefined;
	private remainingSeconds = 0;
	private cachedWidth: number | undefined;
	private cachedRows: number | undefined;
	private cachedLines: string[] | undefined;
	private previewScroll = 0;
	private manualScroll = 0;
	private viewport: { wide: boolean; maxBody: number; maxScroll: number } = {
		wide: false,
		maxBody: 1,
		maxScroll: 0,
	};
	private _focused = false;

	constructor(options: AskUserComponentOptions) {
		this.request = options.request;
		this.deadline = options.deadline;
		this.theme = options.theme;
		this.tui = options.tui;
		this.done = options.done;
		this.mdTheme = buildMarkdownTheme(options.theme);
		this.overlayToggleKey =
			options.request.displayMode === "overlay" ? options.overlayToggleKey : undefined;
		this.drafts = options.request.questions.map(() => emptyDraft());
		this.cursors = options.request.questions.map(() => 0);
		this.inputs = options.request.questions.map(
			(question) => new Input({
				prompt: "› ",
				placeholder: placeholderFor(question),
				placeholderStyle: (text) => this.theme.fg("muted", text),
			}),
		);
		const remaining = Math.max(0, this.deadline.remainingMs());
		this.remainingSeconds = Math.ceil(remaining / 1000);
		this.timer = setTimeout(() => this.finish({ kind: "timeout" }), remaining);
		this.countdownTick = setInterval(() => {
			const seconds = Math.ceil(Math.max(0, this.deadline.remainingMs()) / 1000);
			if (seconds !== this.remainingSeconds) {
				this.remainingSeconds = seconds;
				this.refresh();
			}
		}, 250);
	}

	/**
	 * Set by the TUI when focus changes. Emitting the cursor marker depends on it,
	 * so a change invalidates cached lines.
	 */
	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		if (this._focused === value) return;
		this._focused = value;
		this.cachedWidth = undefined;
		this.cachedRows = undefined;
	}

	// -- lifecycle -----------------------------------------------------------

	abort(): void {
		this.finish({ kind: "abort" });
	}

	dispose(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		if (this.countdownTick) {
			clearInterval(this.countdownTick);
			this.countdownTick = undefined;
		}
	}

	private finish(result: CustomUIResult): void {
		if (this.finished) return;
		this.finished = true;
		this.dispose();
		this.done(result);
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedRows = undefined;
		for (const input of this.inputs) input.invalidate();
		for (const markdown of this.previewCache.values()) markdown.invalidate();
	}

	private refresh(): void {
		this.invalidate();
		this.tui.requestRender();
	}

	private resetScroll(): void {
		this.previewScroll = 0;
		this.manualScroll = 0;
	}

	// -- tab helpers ---------------------------------------------------------

	private get hasReview(): boolean {
		return this.request.questions.length > 1;
	}

	private get tabCount(): number {
		return this.request.questions.length + (this.hasReview ? 1 : 0);
	}

	private get isReview(): boolean {
		return this.hasReview && this.tab === this.request.questions.length;
	}

	private currentQuestion(): NormalizedQuestion {
		return this.request.questions[this.tab]!;
	}

	private rowCount(question: NormalizedQuestion): number {
		return question.options.length + 1;
	}

	private rowIndex(): number {
		if (this.isReview) return 0;
		const question = this.currentQuestion();
		return clamp(this.cursors[this.tab]!, 0, this.rowCount(question) - 1);
	}

	private isInputRow(): boolean {
		if (this.isReview) return false;
		return this.rowIndex() >= this.currentQuestion().options.length;
	}

	private moveTab(delta: number): void {
		// Preserve typed text on the tab being left.
		this.syncAllDrafts();
		this.tab = (this.tab + delta + this.tabCount) % this.tabCount;
		this.reviewButtonFocused = false;
		this.notice = undefined;
		this.resetScroll();
		this.refresh();
	}

	private moveRow(delta: number): void {
		const question = this.currentQuestion();
		this.cursors[this.tab] = clamp(this.rowIndex() + delta, 0, this.rowCount(question) - 1);
		this.resetScroll();
		this.refresh();
	}

	private moveRowToInput(): void {
		this.cursors[this.tab] = this.currentQuestion().options.length;
	}

	// -- draft synchronisation ----------------------------------------------

	/**
	 * Copy the current tab's input value into its draft.
	 *
	 * The `Input` component owns the live text; drafts are the canonical answer.
	 * Every path that reads or submits a draft must sync first, otherwise text
	 * typed and then left via an option selection, a tab switch, or a review
	 * submit would be lost.
	 */
	private syncDraftFromInput(index: number): void {
		const draft = this.drafts[index];
		const input = this.inputs[index];
		if (!draft || !input) return;
		draft.freeText = input.getValue();
	}

	private syncAllDrafts(): void {
		for (let index = 0; index < this.inputs.length; index += 1) this.syncDraftFromInput(index);
	}

	/** Forward a key to the input and drop `usedDefault` if the text changed. */
	private forwardToInput(data: string): void {
		const input = this.inputs[this.tab]!;
		const before = input.getValue();
		input.handleInput(data);
		if (input.getValue() !== before) this.drafts[this.tab]!.usedDefault = false;
	}

	// -- scrolling -----------------------------------------------------------

	private scrollBy(direction: -1 | 1): void {
		if (this.viewport.maxScroll <= 0) return;
		const page = Math.max(1, this.viewport.maxBody - 1);
		if (this.viewport.wide) {
			this.previewScroll = clamp(this.previewScroll + direction * page, 0, this.viewport.maxScroll);
		} else {
			this.manualScroll = clamp(this.manualScroll + direction * page, 0, this.viewport.maxScroll);
		}
		this.refresh();
	}

	private isScrollKey(data: string): boolean {
		if (matchesKey(data, Key.pageUp)) {
			this.scrollBy(-1);
			return true;
		}
		if (matchesKey(data, Key.pageDown)) {
			this.scrollBy(1);
			return true;
		}
		if (this.isInputRow()) return false;
		if (matchesKey(data, "ctrl+u") || data === "[") {
			this.scrollBy(-1);
			return true;
		}
		if (matchesKey(data, "ctrl+d") || data === "]") {
			this.scrollBy(1);
			return true;
		}
		return false;
	}

	// -- key handling --------------------------------------------------------

	handleInput(data: string): void {
		if (this.finished) return;

		if (matchesKey(data, Key.escape)) {
			this.finish({ kind: "cancelled" });
			return;
		}
		if (matchesKey(data, "ctrl+enter")) {
			this.submitAll();
			return;
		}
		if (matchesKey(data, "shift+tab")) {
			this.moveTab(-1);
			return;
		}
		if (matchesKey(data, Key.tab)) {
			this.moveTab(1);
			return;
		}
		if (this.isScrollKey(data)) return;

		if (this.isReview) {
			if (matchesKey(data, Key.down) || matchesKey(data, "ctrl+n")) {
				this.reviewButtonFocused = true;
				this.refresh();
			} else if (matchesKey(data, Key.up) || matchesKey(data, "ctrl+p")) {
				this.reviewButtonFocused = false;
				this.refresh();
			} else if (matchesKey(data, Key.enter) || (this.reviewButtonFocused && matchesKey(data, Key.space))) {
				this.submitAll();
			}
			return;
		}

		const question = this.currentQuestion();
		if (question.kind === "input") {
			this.cursors[this.tab] = question.options.length;
		}

		if (this.isInputRow()) {
			// Up returns to the options instead of being swallowed by the input.
			if (question.options.length > 0 && (matchesKey(data, Key.up) || matchesKey(data, "ctrl+p"))) {
				this.moveRow(-1);
				return;
			}
			if (matchesKey(data, "shift+enter")) {
				this.forwardToInput(data);
				this.refresh();
				return;
			}
			if (matchesKey(data, Key.enter)) {
				this.commitAndAdvance();
				return;
			}
			this.forwardToInput(data);
			this.refresh();
			return;
		}

		if (matchesKey(data, Key.up) || matchesKey(data, "ctrl+p")) {
			this.moveRow(-1);
			return;
		}
		if (matchesKey(data, Key.down) || matchesKey(data, "ctrl+n")) {
			this.moveRow(1);
			return;
		}
		if (matchesKey(data, Key.space)) {
			if (question.kind === "multi") {
				this.toggleRow();
			} else {
				this.syncDraftFromInput(this.tab);
				this.drafts[this.tab]!.selections = [this.rowIndex()];
				this.drafts[this.tab]!.usedDefault = false;
				this.notice = undefined;
				this.resetScroll();
				this.refresh();
			}
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.onOptionEnter();
			return;
		}
		if (matchesKey(data, "s")) {
			this.skipWithDefault();
			return;
		}

		const printable = printableText(data);
		if (printable !== undefined) {
			this.moveRowToInput();
			this.forwardToInput(data);
			this.refresh();
		}
	}

	private onOptionEnter(): void {
		const question = this.currentQuestion();
		if (question.kind === "multi") {
			this.toggleRow();
			return;
		}
		// Sync any typed note before advancing, so selecting an option never drops
		// free text that was entered from the pinned input row.
		this.syncDraftFromInput(this.tab);
		// Single-select: Enter picks and advances. A note can be added first by
		// moving down to the free-input row.
		const row = this.rowIndex();
		this.drafts[this.tab]!.selections = [row];
		this.drafts[this.tab]!.usedDefault = false;
		this.notice = undefined;
		this.resetScroll();
		this.advance();
	}

	private toggleRow(): void {
		this.syncDraftFromInput(this.tab);
		const row = this.rowIndex();
		const draft = this.drafts[this.tab]!;
		if (draft.selections.includes(row)) {
			draft.selections = draft.selections.filter((index) => index !== row);
		} else {
			draft.selections = [...draft.selections, row].sort((a, b) => a - b);
		}
		draft.usedDefault = false;
		this.notice = undefined;
		this.resetScroll();
		this.refresh();
	}

	private skipWithDefault(): void {
		const question = this.currentQuestion();
		const fallback = draftFromDefault(question);
		if (!fallback) {
			this.notice = "This question has no default and is required.";
			this.refresh();
			return;
		}
		this.drafts[this.tab] = fallback;
		this.inputs[this.tab]!.setValue(fallback.freeText);
		this.notice = undefined;
		this.resetScroll();
		this.advance();
	}

	private commitAndAdvance(): void {
		const question = this.currentQuestion();
		this.syncDraftFromInput(this.tab);
		const draft = this.drafts[this.tab]!;
		if (draftIsEmpty(draft) && !question.hasDefault) {
			this.notice = "This question is required: select an option or type text.";
			this.refresh();
			return;
		}
		this.notice = undefined;
		this.resetScroll();
		this.advance();
	}

	private advance(): void {
		// Any transition may lead to a review or submit, so fold every tab's live
		// input text into its draft first.
		this.syncAllDrafts();
		if (this.request.questions.length === 1) {
			this.submitAll();
			return;
		}
		if (this.tab < this.request.questions.length - 1) {
			this.tab += 1;
			this.notice = undefined;
			this.resetScroll();
			this.refresh();
			return;
		}
		this.tab = this.request.questions.length;
		this.reviewButtonFocused = false;
		this.notice = undefined;
		this.resetScroll();
		this.refresh();
	}

	private submitAll(): void {
		// Final safety net: never submit from stale drafts.
		this.syncAllDrafts();
		const { answers, unanswered } = finalizeAnswers(this.request.questions, this.drafts);
		if (unanswered.length > 0) {
			const first = unanswered[0]!;
			this.tab = first;
			this.reviewButtonFocused = false;
			this.cursors[first] = 0;
			this.notice = `Question ${first + 1} has no answer yet; answer it first.`;
			this.resetScroll();
			this.refresh();
			return;
		}
		this.finish({ kind: "submitted", answers });
	}

	// -- rendering helpers ---------------------------------------------------

	private padTo(line: string, width: number): string {
		const visible = visibleWidth(line);
		if (visible >= width) return line;
		return line + " ".repeat(width - visible);
	}

	private countdownLabel(): string {
		const hours = Math.floor(this.remainingSeconds / 3600);
		const minutes = Math.floor((this.remainingSeconds % 3600) / 60);
		const seconds = String(this.remainingSeconds % 60).padStart(2, "0");
		return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
	}

	/** Match the reference dialog's bordered card without affecting input or answers. */
	private frameLines(lines: string[], width: number): string[] {
		const innerWidth = width - 4; // │ + space on each side
		const countdown = truncateToWidth(this.countdownLabel(), Math.max(1, width - 8));
		const label = this.request.header?.trim() || "ask_user";
		const heading = `╭─ ${truncateToWidth(label, Math.max(1, width - visibleWidth(countdown) - 7))} ${countdown} `;
		const top = heading + "─".repeat(width - visibleWidth(heading) - 1) + "╮";
		return [
			this.theme.fg("accent", top),
			...lines.map((line) =>
				this.theme.fg("accent", "│ ") +
				this.padTo(truncateToWidth(line, innerWidth), innerWidth) +
				this.theme.fg("accent", " │"),
			),
			this.theme.fg("accent", "╰" + "─".repeat(width - 2) + "╯"),
		];
	}

	private wrap(text: string, width: number): string[] {
		return wrapTextWithAnsi(text, Math.max(1, width));
	}

	private markdownFor(text: string): Markdown {
		let instance = this.previewCache.get(text);
		if (!instance) {
			instance = new Markdown(text, 0, 0, this.mdTheme);
			this.previewCache.set(text, instance);
		}
		return instance;
	}

	private currentPreview(): string {
		if (this.isReview) return "";
		const question = this.currentQuestion();
		const draft = this.drafts[this.tab]!;
		const row = this.isInputRow() ? (draft.selections[0] ?? -1) : this.rowIndex();
		const option = question.options[row];
		return option?.preview ?? "";
	}

	private autoOffset(total: number, focusLine: number, height: number): number {
		if (total <= height) return 0;
		return clamp(focusLine - Math.floor(height / 2), 0, total - height);
	}

	private renderTabs(width: number): string {
		const inverse = this.theme.inverse ?? ((text: string) => text);
		const chips: string[] = [];
		this.request.questions.forEach((question, index) => {
			const draft = this.drafts[index]!;
			const answered = !draftIsEmpty(draft) || question.hasDefault;
			const marker = answered ? "●" : "○";
			const label = truncateToWidth(question.title, TAB_LABEL_WIDTH);
			const chip = `${marker} ${index + 1}.${label}`;
			chips.push(
				index === this.tab
					? inverse(this.theme.fg("accent", ` ${chip} `))
					: this.theme.fg(answered ? "success" : "muted", ` ${chip} `),
			);
		});
		if (this.hasReview) {
			const chip = "✓ Submit";
			chips.push(
				this.isReview ? inverse(this.theme.fg("accent", ` ${chip} `)) : this.theme.fg("muted", ` ${chip} `),
			);
		}
		return truncateToWidth(chips.join(this.theme.fg("dim", "│")), width);
	}

	private renderOptionRow(question: NormalizedQuestion, index: number, width: number): string[] {
		const draft = this.drafts[this.tab]!;
		const row = this.rowIndex();
		const isCursor = !this.isInputRow() && index === row;
		const selected = draft.selections.includes(index);
		const cursorMark = isCursor ? this.theme.fg("accent", "▸") : " ";
		const box = question.kind === "multi" ? (selected ? "▣" : "▢") : selected ? "◉" : "○";
		const selectedMark = selected ? this.theme.fg("success", box) : this.theme.fg("muted", box);
		const label = question.options[index]!.label;
		const labelText = isCursor ? this.theme.fg("accent", this.theme.bold(label)) : label;
		const lines = [truncateToWidth(`  ${cursorMark} ${selectedMark} ${index + 1}. ${labelText}`, width)];
		const description = question.options[index]!.description;
		if (description) {
			// Wrap to the option column instead of hard-truncating the text.
			for (const wrapped of this.wrap(description, Math.max(1, width - DESCRIPTION_INDENT.length))) {
				lines.push(truncateToWidth(this.theme.fg("muted", `${DESCRIPTION_INDENT}${wrapped}`), width));
			}
		}
		return lines;
	}

	/** Options only (no input row): the input stays pinned outside the body. */
	private renderOptions(width: number): { lines: string[]; focusLine: number } {
		const question = this.currentQuestion();
		const lines: string[] = [];
		let focusLine = 0;
		for (let index = 0; index < question.options.length; index += 1) {
			if (!this.isInputRow() && index === this.rowIndex()) focusLine = lines.length;
			lines.push(...this.renderOptionRow(question, index, width));
		}
		return { lines: lines.map((line) => truncateToWidth(line, width)), focusLine };
	}

	private renderBodyArea(width: number, height: number): string[] {
		if (height <= 0) return [];
		if (this.isReview) {
			const lines = this.renderReview(width);
			const maxScroll = Math.max(0, lines.length - height);
			this.viewport = { wide: false, maxBody: height, maxScroll };
			this.manualScroll = clamp(this.manualScroll, 0, maxScroll);
			return lines.slice(this.manualScroll, this.manualScroll + height);
		}

		const preview = this.currentPreview();
		const wide = preview.trim() !== "" && width >= SPLIT_MIN_WIDTH;

		if (wide) {
			const half = Math.floor(width * 0.5);
			const maxLeft = Math.max(1, width - COLUMN_GAP - 1);
			const lowLeft = Math.min(MIN_LEFT, maxLeft);
			const highLeft = Math.max(lowLeft, Math.min(maxLeft, width - COLUMN_GAP - MIN_PREVIEW));
			const leftWidth = clamp(half, lowLeft, highLeft);
			const rightWidth = Math.max(1, width - leftWidth - COLUMN_GAP);
			const projection = this.renderOptions(leftWidth);
			const right = this.markdownFor(preview).render(rightWidth);
			const leftOffset = this.autoOffset(projection.lines.length, projection.focusLine, height);
			const maxScroll = Math.max(0, right.length - height);
			this.viewport = { wide: true, maxBody: height, maxScroll };
			this.previewScroll = clamp(this.previewScroll, 0, maxScroll);
			const gap = " ".repeat(COLUMN_GAP);
			const totalRows = Math.max(projection.lines.length - leftOffset, right.length - this.previewScroll);
			const visibleCount = clamp(totalRows, 1, height);
			const merged: string[] = [];
			for (let index = 0; index < visibleCount; index += 1) {
				const leftLine = projection.lines[leftOffset + index] ?? "";
				const rightLine = right[this.previewScroll + index] ?? "";
				merged.push(
					this.padTo(truncateToWidth(leftLine, leftWidth), leftWidth) +
						gap +
						truncateToWidth(rightLine, rightWidth),
				);
			}
			return merged;
		}

		const projection = this.renderOptions(width);
		const lines = projection.lines.slice();
		if (preview.trim() !== "") {
			lines.push("");
			lines.push(this.theme.fg("border", "─".repeat(width)));
			lines.push(this.theme.fg("muted", "Preview:"));
			lines.push(...this.markdownFor(preview).render(width));
		}
		const maxScroll = Math.max(0, lines.length - height);
		this.viewport = { wide: false, maxBody: height, maxScroll };
		this.manualScroll = clamp(this.manualScroll, 0, maxScroll);
		const offset =
			this.manualScroll > 0 ? this.manualScroll : this.autoOffset(lines.length, projection.focusLine, height);
		return lines.slice(offset, offset + height);
	}

	/** The free-input row, rendered as a fixed line that never scrolls away. */
	private renderInputBar(width: number): string[] {
		const input = this.inputs[this.tab]!;
		input.focused = this.focused && this.isInputRow();
		return input
			.render(Math.max(1, width - 2))
			.slice(0, 1)
			.map((line) => {
				// Pi's Input draws an inverse-video fake cursor even when unfocused.
				// Only show that highlight while this row actually owns input focus.
				const display = input.focused ? line : line.replaceAll("\x1b[7m", "").replaceAll("\x1b[27m", "");
				return truncateToWidth(`  ${display}`, width);
			});
	}

	private renderSubmitBar(width: number): string[] {
		const label = this.reviewButtonFocused ? "▸ [ Enter Submit ]" : "  [ Enter Submit ]";
		const styled = this.theme.fg("accent", this.reviewButtonFocused ? (this.theme.inverse?.(label) ?? label) : label);
		return [truncateToWidth(styled, width)];
	}

	private renderReview(width: number): string[] {
		const lines: string[] = [];
		this.request.questions.forEach((question, index) => {
			const draft = this.drafts[index]!;
			const answered = !draftIsEmpty(draft) || question.hasDefault;
			const mark = answered ? this.theme.fg("success", "✓") : this.theme.fg("warning", "!");
			lines.push(truncateToWidth(`${mark} ${this.theme.bold(`${index + 1}. ${question.title}`)}`, width));
			lines.push(truncateToWidth(this.theme.fg("muted", `   ${this.describeDraft(question, draft)}`), width));
		});
		return lines;
	}

	private describeDraft(question: NormalizedQuestion, draft: DraftAnswer): string {
		const parts: string[] = [];
		if (draft.selections.length > 0) {
			parts.push(draft.selections.map((index) => question.options[index]?.label ?? `#${index + 1}`).join(", "));
		}
		const freeText = draft.freeText.trim();
		if (freeText !== "") parts.push(`"${freeText}"`);
		if (parts.length === 0) {
			const fallback = draftFromDefault(question);
			if (fallback) return `Will use the default: ${question.default}`;
			return "(unanswered)";
		}
		const suffix = draft.usedDefault ? " (default)" : "";
		return parts.join(" | ") + suffix;
	}

	private hintLine(): string {
		const toggleHint = this.overlayToggleKey ? `${this.overlayToggleKey} hide` : undefined;
		if (this.isReview) {
			const reviewHints = ["↓ focus submit", "Enter submit", "Tab switch question"];
			if (toggleHint) reviewHints.push(toggleHint);
			reviewHints.push("Esc cancel");
			return this.theme.fg("dim", reviewHints.join(" · "));
		}
		const question = this.currentQuestion();
		const hints = ["Tab switch", "↑/↓ move", `Enter ${this.isInputRow() ? "confirm" : "select"}`];
		if (question.kind === "multi") hints.push("Space multi-select");
		if (question.hasDefault) hints.push("s use default");
		if (this.viewport.maxScroll > 0) hints.push("PgUp/PgDn preview");
		if (this.isInputRow() && question.options.length > 0) hints.push("↑ back to options");
		if (toggleHint) hints.push(toggleHint);
		hints.push("Esc cancel");
		return this.theme.fg("dim", hints.join(" · "));
	}

	render(width: number): string[] {
		const lineWidth = Math.max(1, Math.floor(width));
		const physical = Math.max(0, Math.floor(this.tui.terminal?.rows ?? DEFAULT_ROWS));
		if (this.cachedLines && this.cachedWidth === lineWidth && this.cachedRows === physical) return this.cachedLines;
		if (physical === 0) {
			this.cachedWidth = lineWidth;
			this.cachedRows = physical;
			this.cachedLines = [];
			return [];
		}

		// The host caps overlays at 85% with a one-row margin. Respect that cap
		// ourselves so the host never chops off the pinned input or bottom border.
		const availableRows = this.request.displayMode === "overlay" && physical >= 7
			? Math.min(physical, Math.floor(physical * OVERLAY_MAX_HEIGHT_RATIO), Math.max(0, physical - 2 * OVERLAY_MARGIN))
			: physical;
		// Small viewports keep the original minimal layout so controls remain visible.
		const framed = lineWidth >= 16 && availableRows >= 7;
		const contentWidth = framed ? lineWidth - 4 : lineWidth;
		const contentRows = framed ? availableRows - 2 : availableRows;

		// Fixed blocks, with the free-input row and key hints guaranteed highest
		// priority so they survive a short terminal.
		const titleText = this.isReview
			? "Review before submitting"
			: `${this.currentQuestion().index + 1}/${this.request.questions.length}. ${this.currentQuestion().title}`;
		const titleBlock = this.wrap(this.theme.bold(this.theme.fg("accent", titleText)), contentWidth).slice(
			0,
			MAX_TITLE_LINES,
		);
		const tabsBlock = this.request.questions.length > 1 ? [this.renderTabs(contentWidth)] : [];
		const countdown = this.countdownLabel();
		const headerBlock = !framed
			? [contentWidth <= visibleWidth(countdown) + 1
				? truncateToWidth(countdown, contentWidth)
				: `${this.theme.bold(truncateToWidth(this.request.header?.trim() || "ask_user", contentWidth - visibleWidth(countdown) - 1))} ${countdown}`]
			: [];
		const prompt = this.isReview ? undefined : this.currentQuestion().prompt?.trim();
		const promptBlock = prompt
			? this.wrap(this.theme.fg("text", prompt), contentWidth).slice(0, MAX_PROMPT_LINES)
			: [];
		const noticeBlock = this.notice
			? this.wrap(this.theme.fg("warning", `⚠ ${this.notice}`), contentWidth).slice(0, MAX_NOTICE_LINES)
			: [];
		const inputBlock = this.isReview ? this.renderSubmitBar(contentWidth) : this.renderInputBar(contentWidth);
		const hintBlock = [this.hintLine()];

		let remaining = contentRows;
		const take = (block: string[]): string[] => {
			if (remaining <= 0 || block.length === 0) return [];
			const use = Math.min(block.length, remaining);
			remaining -= use;
			return block.slice(0, use);
		};
		const inputOut = take(inputBlock);
		const hintOut = take(hintBlock);
		const titleOut = take(titleBlock);
		const tabsOut = take(tabsBlock);
		const headerOut = take(headerBlock);
		const noticeOut = take(noticeBlock);
		const promptOut = take(promptBlock);
		const bodyOut = remaining > 0 ? this.renderBodyArea(contentWidth, remaining) : [];

		const leading = [...headerOut, ...tabsOut, ...titleOut, ...promptOut, ...noticeOut, ...bodyOut];
		const minimum = this.request.displayMode === "overlay" ? Math.min(MIN_OVERLAY_ROWS, availableRows) : 0;
		const padding = Math.max(0, minimum - (leading.length + inputOut.length + hintOut.length + (framed ? 2 : 0)));
		// Keep input/Submit adjacent to the choices, while pinning the key hints
		// to the bottom edge of a padded overlay.
		const lines = [...leading, ...inputOut, ...Array<string>(padding).fill(""), ...hintOut];
		const content = lines.slice(0, contentRows).map((line) => truncateToWidth(line, contentWidth));
		const finalLines = framed ? this.frameLines(content, lineWidth) : content;
		this.cachedWidth = lineWidth;
		this.cachedRows = physical;
		this.cachedLines = finalLines;
		return finalLines;
	}
}
