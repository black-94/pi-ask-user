import type { AskUserUIMode } from "./types.ts";

/**
 * Forced UI-mode configuration.
 *
 * The route is never detected and never downgraded. It is resolved once, by a
 * trusted host adapter, in this precedence order:
 *
 *  1. the programmatic `mode` option (`createPiHost(ctx, { mode })`,
 *     `askUser(request, { host, mode })`),
 *  2. the `PI_ASK_USER_UI_MODE` environment variable,
 *  3. {@link DEFAULT_UI_MODE}.
 *
 * An invalid value at any level is an actionable error, never a fallback. Model
 * tool parameters are not part of this chain and cannot influence it.
 */

/** Environment variable read by the trusted Pi host adapter. */
export const UI_MODE_ENV_VAR = "PI_ASK_USER_UI_MODE";

/** The route used when nothing is configured. */
export const DEFAULT_UI_MODE: AskUserUIMode = "native";

/** The only accepted values, in documentation order. */
export const UI_MODES: readonly AskUserUIMode[] = ["custom", "native", "text"];

export function isUIMode(value: unknown): value is AskUserUIMode {
	return typeof value === "string" && (UI_MODES as readonly string[]).includes(value);
}

/** Trim + lowercase, then accept only a known mode. */
export function normalizeUIMode(raw: string): AskUserUIMode | undefined {
	const value = raw.trim().toLowerCase();
	return isUIMode(value) ? value : undefined;
}

export type ModeResolution = { ok: true; mode: AskUserUIMode } | { ok: false; message: string };

/**
 * Resolve the forced UI mode.
 *
 * `programmatic` wins when present; otherwise `envOrHost` (the raw environment
 * value, or an already-resolved adapter mode) is used; otherwise the default.
 */
export function resolveUIMode(programmatic: AskUserUIMode | undefined, envOrHost: string | undefined): ModeResolution {
	const allowed = UI_MODES.join(" | ");
	if (programmatic !== undefined) {
		if (!isUIMode(programmatic)) {
			return { ok: false, message: `无效的 UI 模式 ${JSON.stringify(programmatic)}；可选值：${allowed}。` };
		}
		return { ok: true, mode: programmatic };
	}
	const raw = typeof envOrHost === "string" ? envOrHost.trim() : "";
	if (raw === "") return { ok: true, mode: DEFAULT_UI_MODE };
	const mode = normalizeUIMode(raw);
	if (!mode) {
		return { ok: false, message: `${UI_MODE_ENV_VAR} 的值无效：${JSON.stringify(envOrHost)}；可选值：${allowed}。` };
	}
	return { ok: true, mode };
}
