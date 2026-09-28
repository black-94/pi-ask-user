import type { PlainTextOutputHook } from "./types.ts";

/**
 * Buffer for the no-UI route.
 *
 * The plain-text questionnaire is queued here while a tool call is running and
 * flushed by the host's `message_end` hook onto the final assistant message,
 * after the model's answer is complete and before control returns to the caller.
 * Nothing is ever written to stdout directly, so JSON/RPC protocol streams stay
 * clean.
 */
export class AppendixRegistry {
	private chunks: string[] = [];

	queue(text: string): void {
		if (typeof text === "string" && text.trim() !== "") {
			this.chunks.push(text);
		}
	}

	hasPending(): boolean {
		return this.chunks.length > 0;
	}

	takeAll(): string | undefined {
		if (this.chunks.length === 0) return undefined;
		const text = this.chunks.join("\n\n");
		this.chunks = [];
		return text;
	}

	clear(): void {
		this.chunks = [];
	}
}

/** Shared registry used by the default extension instance. */
export const defaultAppendixRegistry = new AppendixRegistry();

/** Create a plain-text output hook backed by a registry. */
export function createPlainTextHook(registry: AppendixRegistry = defaultAppendixRegistry): PlainTextOutputHook {
	return {
		available: true,
		queue: (text: string) => registry.queue(text),
	};
}

/** A hook for hosts with no output hook: the caller must deliver the text. */
export function createUnavailablePlainTextHook(): PlainTextOutputHook {
	return { available: false, queue: () => {} };
}

interface ContentBlock {
	type?: unknown;
	text?: unknown;
}

interface AppendableMessage {
	role?: unknown;
	content?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * Append a queued plain-text appendix to a finalized assistant message.
 *
 * Returns a replacement message, or `undefined` when nothing should change.
 * A message that still contains tool calls is not the model's final answer, so
 * the appendix is held for the following assistant message.
 */
export function flushAppendix<T extends AppendableMessage>(message: T, registry: AppendixRegistry): T | undefined {
	if (message.role !== "assistant") return undefined;
	const content = Array.isArray(message.content) ? (message.content as ContentBlock[]) : [];
	const hasToolCall = content.some((block) => isRecord(block) && block.type === "toolCall");
	if (hasToolCall) return undefined;
	if (!registry.hasPending()) return undefined;
	const appendix = registry.takeAll();
	if (!appendix) return undefined;
	return { ...message, content: [...content, { type: "text", text: appendix }] } as T;
}
