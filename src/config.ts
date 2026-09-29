/**
 * User configuration for AskUser.
 *
 * Configuration is a plain JSON file — never environment variables. It lives in
 * a per-user directory and is read **once per host/session creation**, never per
 * request:
 *
 *   ~/.pi/ask-user/config.json
 *
 * No file (or an empty file) means the built-in defaults. An existing file is
 * validated strictly: malformed JSON, unknown keys, and bad values are reported
 * as actionable `invalid_config` errors instead of being silently ignored or
 * coerced. There are deliberately no environment-variable knobs.
 *
 * Effective precedence for every knob is:
 *
 *   explicit programmatic option  >  user config file  >  built-in default
 *
 * Built-in defaults (which the model's request may override when the user did
 * not configure anything) are applied by the core, not here: this module only
 * reports what the user actually configured, leaving unset knobs `undefined`.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AskUserDisplayMode, AskUserMode, AskUserUiPreferences } from "./types.ts";

/** Directory holding the user config file. */
export const USER_CONFIG_DIR = join(homedir(), ".pi", "ask-user");
/** The documented user config file. */
export const USER_CONFIG_PATH = join(USER_CONFIG_DIR, "config.json");

/** Built-in default key that toggles the overlay between hidden and visible. */
export const DEFAULT_OVERLAY_TOGGLE_KEY = "alt+o";
/** Built-in default custom-UI presentation. */
export const DEFAULT_DISPLAY_MODE: AskUserDisplayMode = "overlay";

const CONFIG_KEYS = ["mode", "displayMode", "overlayToggleKey", "timeoutPerQuestionMs"] as const;
const DISPLAY_MODES: readonly AskUserDisplayMode[] = ["overlay", "inline"];
/** Values that explicitly turn a configurable shortcut off. */
const SHORTCUT_DISABLE_VALUES = new Set(["off", "none", "disabled", ""]);

/** Modifiers pi-tui's KeyId grammar understands. */
const MODIFIER_NAMES = new Set(["ctrl", "shift", "alt", "super"]);
/** Printable base keys (a key that produces text and would steal typing). */
const SYMBOL_BASES = new Set([
	"`",
	"-",
	"=",
	"[",
	"]",
	"\\",
	";",
	"'",
	",",
	".",
	"/",
	"!",
	"@",
	"#",
	"$",
	"%",
	"^",
	"&",
	"*",
	"(",
	")",
	"_",
	"+",
	"|",
	"~",
	"{",
	"}",
	":",
	"<",
	">",
	"?",
]);
const FUNCTION_BASES = new Set(
	Array.from({ length: 12 }, (_, index) => `f${index + 1}`),
);
/** Every non-printable base key the KeyId grammar accepts. */
const SPECIAL_BASES = new Set([
	"escape",
	"esc",
	"enter",
	"return",
	"tab",
	"space",
	"backspace",
	"delete",
	"insert",
	"clear",
	"home",
	"end",
	"pageup",
	"pagedown",
	"up",
	"down",
	"left",
	"right",
	...FUNCTION_BASES,
]);
/**
 * Special keys the questionnaire itself uses. A raw toggle listener consumes a
 * match *before* the component sees it, so any of these would shadow the
 * interaction — `Esc` (cancel) above all. They are rejected, never silently
 * swapped for something else.
 */
const RESERVED_BASES = new Set([
	"escape",
	"esc",
	"enter",
	"return",
	"tab",
	"space",
	"backspace",
	"delete",
	"insert",
	"clear",
	"home",
	"end",
	"pageup",
	"pagedown",
	"up",
	"down",
	"left",
	"right",
]);
/** Modifier chords that conflict with a questionnaire control. */
const RESERVED_SIGNATURES = new Set(
	["ctrl+c", "ctrl+d", "ctrl+u", "ctrl+p", "ctrl+n", "ctrl+enter"].map((id) => {
		const parts = id.split("+");
		const base = parts.pop()!;
		return [...parts.sort(), base].join("+");
	}),
);

interface ParsedShortcut {
	base: string;
	modifiers: string[];
	signature: string;
}

function isPrintableBase(base: string): boolean {
	return /^[a-z0-9]$/.test(base) || SYMBOL_BASES.has(base);
}

function hasChordModifier(modifiers: string[]): boolean {
	return modifiers.some((modifier) => modifier === "ctrl" || modifier === "alt" || modifier === "super");
}

/** Parse a spec against the supported KeyId grammar; `null` when malformed. */
function parseOverlayToggleSpec(spec: string): ParsedShortcut | null {
	const parts = spec.toLowerCase().split("+");
	if (parts.some((part) => part === "")) return null;
	const base = parts.pop()!;
	const modifiers = parts;
	if (modifiers.some((modifier) => !MODIFIER_NAMES.has(modifier))) return null;
	if (new Set(modifiers).size !== modifiers.length) return null;
	if (!isPrintableBase(base) && !SPECIAL_BASES.has(base)) return null;
	return { base, modifiers, signature: [...modifiers].sort().join("+") + "+" + base };
}

/**
 * Whether a spec is safe to bind as the overlay show/hide key: a syntactically
 * valid KeyId chord that neither collides with a questionnaire control nor
 * captures ordinary typing. Used by the renderer as a defensive guard; the
 * config layer reports the specific reason instead.
 */
export function isAllowedOverlayToggleSpec(spec: string): boolean {
	const parsed = parseOverlayToggleSpec(spec.toLowerCase());
	if (!parsed) return false;
	if (RESERVED_BASES.has(parsed.base)) return false;
	if (isPrintableBase(parsed.base) && !hasChordModifier(parsed.modifiers)) return false;
	if (RESERVED_SIGNATURES.has(parsed.signature)) return false;
	return true;
}

/**
 * Validate a shortcut spec, or `null` to disable; throws an actionable
 * {@link AskUserConfigError} on anything malformed or conflicting. Never
 * substitutes a different key.
 */
export function normalizeOverlayToggleKey(value: unknown, source: string): string | null {
	const where = errorSource(source);
	if (value === null) return null;
	if (typeof value !== "string") {
		throw new AskUserConfigError(where, '"overlayToggleKey" must be a key chord like "alt+o", or null/"off"/"none"/"disabled" to disable it');
	}
	const spec = value.trim().toLowerCase();
	if (SHORTCUT_DISABLE_VALUES.has(spec)) return null;
	const parsed = parseOverlayToggleSpec(spec);
	if (!parsed) {
		throw new AskUserConfigError(where, `"overlayToggleKey" is not a supported key: ${JSON.stringify(value)} (expected a chord like "alt+o", or "off" to disable)`);
	}
	if (RESERVED_BASES.has(parsed.base)) {
		throw new AskUserConfigError(where, `"overlayToggleKey" cannot be ${JSON.stringify(value)}: it is reserved by the questionnaire (for example Esc cancels and Enter submits). Choose another chord or set it to "off" to disable`);
	}
	if (isPrintableBase(parsed.base) && !hasChordModifier(parsed.modifiers)) {
		throw new AskUserConfigError(where, `"overlayToggleKey" ${JSON.stringify(value)} would capture ordinary typing; use a chord with ctrl/alt/super such as "alt+o", or "off" to disable`);
	}
	if (RESERVED_SIGNATURES.has(parsed.signature)) {
		throw new AskUserConfigError(where, `"overlayToggleKey" cannot be ${JSON.stringify(value)}: it conflicts with a questionnaire control. Choose another chord or set it to "off" to disable`);
	}
	return spec;
}

/**
 * The knobs the user may set, in the order they are documented. Every field is
 * optional: `undefined` means "not configured here", so a later layer (or the
 * built-in default) applies.
 */
export interface AskUserConfigOverrides {
	mode?: AskUserMode;
	/** `undefined` = not configured. */
	displayMode?: AskUserDisplayMode;
	/** `undefined` = not configured (built-in `alt+o`); `null` = explicitly disabled. */
	overlayToggleKey?: string | null;
	/** `undefined` = not configured. */
	timeoutPerQuestionMs?: number;
}

/** The outcome of resolving the config for one host/session. */
export interface ResolvedAskUserConfig {
	/** Only the knobs that were actually configured; unset knobs are absent. */
	config: AskUserConfigOverrides;
	/** True when a config file existed and was parsed. */
	loaded: boolean;
	/** The config file path, when one was read (whether or not it existed). */
	path?: string;
	/** Present when the file or programmatic options were invalid. Never thrown. */
	error?: AskUserConfigError;
}

/** An actionable configuration failure. */
export class AskUserConfigError extends Error {
	readonly code = "invalid_config";
	readonly source: string;

	constructor(source: string, message: string) {
		super(`${message} (${source})`);
		this.name = "AskUserConfigError";
		this.source = source;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorSource(source: string): string {
	return source === "options" ? "programmatic options" : source;
}

function readMode(value: unknown, source: string): AskUserMode {
	const where = errorSource(source);
	if (value === "custom" || value === "native") return value;
	throw new AskUserConfigError(where, `"mode" must be "custom" or "native", received ${JSON.stringify(value)}`);
}

function readDisplayMode(value: unknown, source: string): AskUserDisplayMode {
	const where = errorSource(source);
	if (typeof value === "string" && (DISPLAY_MODES as readonly string[]).includes(value)) {
		return value as AskUserDisplayMode;
	}
	throw new AskUserConfigError(where, `"displayMode" must be "overlay" or "inline", received ${JSON.stringify(value)}`);
}

function readTimeout(value: unknown, source: string): number {
	const where = errorSource(source);
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new AskUserConfigError(where, `"timeoutPerQuestionMs" must be a non-negative finite number, received ${JSON.stringify(value)}`);
	}
	return Math.floor(value);
}

/**
 * Strictly validate an already-parsed config object (from the file or from
 * programmatic options). Unknown keys, wrong types, and out-of-range values all
 * throw {@link AskUserConfigError}. `mode` is accepted without a range check so
 * an invalid programmatic mode can surface through route resolution as
 * `invalid_config` with the list of runnable modes, exactly as before.
 */
export function parseAskUserConfig(raw: unknown, source: string): AskUserConfigOverrides {
	if (!isRecord(raw)) {
		throw new AskUserConfigError(errorSource(source), `the configuration must be a JSON object, received ${Array.isArray(raw) ? "an array" : typeof raw}`);
	}
	for (const key of Object.keys(raw)) {
		if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
			throw new AskUserConfigError(errorSource(source), `unknown key ${JSON.stringify(key)}; allowed keys: ${CONFIG_KEYS.join(", ")}`);
		}
	}
	const out: AskUserConfigOverrides = {};
	if ("mode" in raw) out.mode = readMode(raw.mode, source);
	if ("displayMode" in raw) out.displayMode = readDisplayMode(raw.displayMode, source);
	if ("overlayToggleKey" in raw) out.overlayToggleKey = normalizeOverlayToggleKey(raw.overlayToggleKey, source);
	if ("timeoutPerQuestionMs" in raw) out.timeoutPerQuestionMs = readTimeout(raw.timeoutPerQuestionMs, source);
	return out;
}

/** Validate programmatic options, leaving `mode` to route resolution. */
export function parseAskUserOptions(raw: AskUserConfigOverrides): AskUserConfigOverrides {
	const out: AskUserConfigOverrides = {};
	if (raw.mode !== undefined) out.mode = raw.mode;
	if (raw.displayMode !== undefined) out.displayMode = readDisplayMode(raw.displayMode, "options");
	if ("overlayToggleKey" in raw) out.overlayToggleKey = normalizeOverlayToggleKey(raw.overlayToggleKey, "options");
	if (raw.timeoutPerQuestionMs !== undefined) out.timeoutPerQuestionMs = readTimeout(raw.timeoutPerQuestionMs, "options");
	return out;
}

/**
 * Read and validate the config file. A missing file yields no overrides;
 * unreadable, malformed, or invalid content throws {@link AskUserConfigError}.
 * An empty/whitespace-only file is treated as "no configuration".
 */
export function readAskUserConfigFile(path: string): { overrides: AskUserConfigOverrides; loaded: boolean } {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException | undefined)?.code;
		if (code === "ENOENT") return { overrides: {}, loaded: false };
		const message = error instanceof Error ? error.message : String(error);
		throw new AskUserConfigError(path, `could not read the AskUser config file: ${message}`);
	}
	if (text.trim() === "") return { overrides: {}, loaded: false };
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new AskUserConfigError(path, `the file is not valid JSON: ${message}`);
	}
	return { overrides: parseAskUserConfig(parsed, path), loaded: true };
}

/**
 * Resolve the effective user configuration for one host/session.
 *
 * Precedence per knob is programmatic option > config file. Invalid input is
 * returned as `error` (never thrown) so the host can refuse every request with
 * an actionable `invalid_config` result instead of falling back.
 */
export function resolveAskUserConfig(
	programmatic: AskUserConfigOverrides = {},
	options: { configFile?: string | false } = {},
): ResolvedAskUserConfig {
	try {
		const clean = parseAskUserOptions(programmatic);
		let file: { overrides: AskUserConfigOverrides; loaded: boolean } = { overrides: {}, loaded: false };
		const path = options.configFile === false ? undefined : (options.configFile ?? USER_CONFIG_PATH);
		if (path !== undefined) file = readAskUserConfigFile(path);

		const config: AskUserConfigOverrides = {};
		const mode = clean.mode ?? file.overrides.mode;
		if (mode !== undefined) config.mode = mode;
		const displayMode = clean.displayMode ?? file.overrides.displayMode;
		if (displayMode !== undefined) config.displayMode = displayMode;
		const overlayToggleKey =
			"overlayToggleKey" in clean ? clean.overlayToggleKey : file.overrides.overlayToggleKey;
		if (overlayToggleKey !== undefined) config.overlayToggleKey = overlayToggleKey;
		const timeoutPerQuestionMs = clean.timeoutPerQuestionMs ?? file.overrides.timeoutPerQuestionMs;
		if (timeoutPerQuestionMs !== undefined) config.timeoutPerQuestionMs = timeoutPerQuestionMs;

		const resolved: ResolvedAskUserConfig = { config, loaded: file.loaded };
		if (path !== undefined) resolved.path = path;
		return resolved;
	} catch (error) {
		if (error instanceof AskUserConfigError) return { config: {}, loaded: false, error };
		return {
			config: {},
			loaded: false,
			error: new AskUserConfigError("options", error instanceof Error ? error.message : String(error)),
		};
	}
}

/**
 * Project resolved overrides onto the per-host UI preferences. Unset knobs stay
 * absent so the core can let the model's request fill the gap; `overlayToggleKey`
 * is preserved as `null` when explicitly disabled.
 */
export function toUiPreferences(config: AskUserConfigOverrides): AskUserUiPreferences {
	const preferences: AskUserUiPreferences = {};
	if (config.displayMode !== undefined) preferences.displayMode = config.displayMode;
	if (config.overlayToggleKey !== undefined) preferences.overlayToggleKey = config.overlayToggleKey;
	if (config.timeoutPerQuestionMs !== undefined) preferences.timeoutPerQuestionMs = config.timeoutPerQuestionMs;
	return preferences;
}
