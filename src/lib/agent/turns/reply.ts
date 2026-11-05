/**
 * W7 reply/quote: a message may reference an earlier one (`replyTo`). The context builder inlines
 * the referenced message, truncated and clearly marked, ahead of the new text; steer messages are
 * wrapped so the model knows they arrived while it was working.
 */
export const REF_MAX = 600;

export type Ref = { role?: string; excerpt?: string };

export function clipExcerpt(text: string, max = REF_MAX) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function withReference(content: string, ref?: Ref | null) {
  const excerpt = typeof ref?.excerpt === "string" ? clipExcerpt(ref.excerpt) : "";
  if (!excerpt) return content;
  const who = ref?.role === "assistant" ? "your earlier reply" : "an earlier message from the owner";
  return `[Referenced message — ${who}, quoted (may be truncated): "${excerpt}"]\n\n${content}`;
}

/** Apply `replyTo` on raw request messages (unknown input; anything malformed is ignored). */
export function decorateReplies(raw: unknown[]): unknown[] {
  return raw.map((item) => {
    if (!item || typeof item !== "object") return item;
    const m = item as { role?: unknown; content?: unknown; replyTo?: unknown };
    if (typeof m.content !== "string" || !m.replyTo || typeof m.replyTo !== "object") return item;
    return { role: m.role, content: withReference(m.content, m.replyTo as Ref) };
  });
}

/** How a mid-turn (steered) owner message is presented to the model. */
export function steerText(content: string) {
  return `[New message from the owner while you were working — read it and adjust what you are doing if needed]\n\n${content}`;
}
