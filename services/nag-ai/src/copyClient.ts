import type Anthropic from "@anthropic-ai/sdk";
import type { CopyResult } from "@alarmed/core";

/**
 * Default model for this endpoint: a small, fast model is enough for one
 * short line of rewritten notification copy, and keeps latency low since
 * this call sits in the live "user just tapped Snooze" path. Overridable via
 * env so a deprecated dated snapshot can be bumped without a code change.
 */
export const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

const MAX_LINE_LENGTH = 140;

export interface NagCopyRequest {
  title: string;
  notes?: string | null;
  /** Escalation level — see packages/core/src/copy.ts; roughly "times ignored". */
  level: number;
}

/** The subset of the Anthropic client this module actually calls — keeps tests light. */
export type AnthropicMessages = Pick<Anthropic, "messages">;

function buildPrompt(request: NagCopyRequest): string {
  const notesLine = request.notes?.trim()
    ? ` The task's own note is: "${request.notes.trim()}".`
    : "";
  return (
    `You write a single short line for a phone reminder notification body. ` +
    `The task is "${request.title}".${notesLine} ` +
    `The user has ignored/snoozed this reminder about ${request.level} time(s) so far. ` +
    `Write one line, escalating in impatience and sarcasm proportional to that count — ` +
    `more clipped and pointed at low counts, openly exasperated and mocking at high counts. ` +
    `Never use profanity or genuinely cruel language, never threaten the user, stay under ` +
    `${MAX_LINE_LENGTH} characters. Reply with only the line itself, no quotes, no preamble.`
  );
}

/**
 * Calls Claude for one escalated nag line. Throws on any SDK error or an
 * empty/oversized response — callers (the HTTP handler) turn that into a
 * failure response so the client falls back to its local template ladder.
 */
export async function generateEscalatedLine(
  request: NagCopyRequest,
  client: AnthropicMessages,
  model: string = DEFAULT_MODEL
): Promise<CopyResult> {
  const response = await client.messages.create({
    model,
    max_tokens: 60,
    messages: [{ role: "user", content: buildPrompt(request) }],
  });

  const block = response.content.find((b) => b.type === "text");
  const line = block && "text" in block ? block.text.trim() : "";

  if (!line || line.length > MAX_LINE_LENGTH) {
    throw new Error("nag-ai: empty or oversized response from model");
  }

  return { title: request.title, body: line };
}
