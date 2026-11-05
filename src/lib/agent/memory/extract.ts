/**
 * Automatic memory extraction: prompt building and strict parsing of the
 * model's JSON answer. Pure; the server runs the cheap model call.
 */
import { redactSecrets } from "./redact.ts";
import type { Memory, MemoryKind } from "./types.ts";

export const EXTRACT_WINDOW = 6;
const WINDOW_CHARS = 2_500;
const MAX_OPS = 8;

export type ExtractMsg = { role: "user" | "assistant"; content: string };

export type Extraction = {
  add: { text: string; kind: MemoryKind; eventDate?: string; tags: string[] }[];
  update: { id: string; text: string }[];
  forget: string[];
};

export const EXTRACT_SYSTEM = `You maintain the long-term memory of Sable, a personal assistant with exactly one user.
Read the latest exchange and decide what is worth remembering about THE USER for future conversations.

Keep only durable, useful facts:
- profile: stable preferences, how they like answers, standing instructions, who they are, their tools/stack, long-running projects and goals.
- journal: dated events, deadlines, decisions or project milestones (give eventDate YYYY-MM-DD when a date is known; resolve "tomorrow" etc. using the date given).

Never store: passwords, API keys, tokens, OTP codes, card or bank numbers, ID numbers, addresses of other people, health or other sensitive details unless the user explicitly asked to remember them, one-off questions, the assistant's own opinions, facts from web pages or tool output, small talk, or anything already in the existing memories unchanged.
If the user says something changed, emit an update for the old memory id. If the user asks to forget something, list its id in forget.
Each text: one short sentence (max 200 characters), third person ("Người dùng …" / "The user …"), in the user's language.
Answer with ONLY a JSON object, no prose, no code fence:
{"add":[{"text":"…","kind":"profile"|"journal","eventDate":"YYYY-MM-DD"?,"tags":["…"]}],"update":[{"id":"…","text":"…"}],"forget":["id"]}
Most exchanges contain nothing worth keeping: then answer {"add":[],"update":[],"forget":[]}.`;

function clip(text: string, max: number) {
  const trimmed = text.replace(/\s+\n/g, "\n").trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)} …[cắt]` : trimmed;
}

/** The user message for the extractor: date, existing related memories (with ids), the last few turns. */
export function buildExtractPrompt(window: ExtractMsg[], related: Memory[], today: string) {
  const turns = window
    .slice(-EXTRACT_WINDOW)
    .map((message) => `${message.role === "user" ? "USER" : "ASSISTANT"}: ${redactSecrets(clip(message.content, WINDOW_CHARS)).text}`)
    .join("\n\n");
  const existing = related.length
    ? related.map((memory) => `${memory.id} [${memory.kind}] ${memory.text}`).join("\n")
    : "(none)";
  return `Today: ${today} (Asia/Saigon)\n\nExisting memories that may be related:\n${existing}\n\nLatest exchange:\n${turns}`;
}

function stripFence(text: string) {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) return fence[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
}

/** Parse the extractor's answer. Anything malformed yields an empty extraction (never throws). */
export function parseExtraction(raw: string, knownIds: Set<string>): Extraction {
  const empty: Extraction = { add: [], update: [], forget: [] };
  let value: unknown;
  try {
    value = JSON.parse(stripFence(raw));
  } catch {
    return empty;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return empty;
  const body = value as Record<string, unknown>;
  const out: Extraction = { add: [], update: [], forget: [] };
  if (Array.isArray(body.add)) {
    for (const item of body.add.slice(0, MAX_OPS)) {
      if (!item || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      if (typeof entry.text !== "string" || !entry.text.trim()) continue;
      out.add.push({
        text: entry.text.trim().slice(0, 300),
        kind: entry.kind === "journal" ? "journal" : "profile",
        eventDate: typeof entry.eventDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(entry.eventDate) ? entry.eventDate : undefined,
        tags: Array.isArray(entry.tags) ? entry.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 6) : [],
      });
    }
  }
  if (Array.isArray(body.update)) {
    for (const item of body.update.slice(0, MAX_OPS)) {
      if (!item || typeof item !== "object") continue;
      const entry = item as Record<string, unknown>;
      if (typeof entry.id === "string" && knownIds.has(entry.id) && typeof entry.text === "string" && entry.text.trim())
        out.update.push({ id: entry.id, text: entry.text.trim().slice(0, 300) });
    }
  }
  if (Array.isArray(body.forget)) {
    for (const id of body.forget.slice(0, MAX_OPS)) if (typeof id === "string" && knownIds.has(id)) out.forget.push(id);
  }
  return out;
}

/** Cheap pre-filter: skip the model call when the exchange cannot hold a durable fact. */
export function worthExtracting(window: ExtractMsg[]) {
  const user = window.filter((message) => message.role === "user").at(-1)?.content.trim() ?? "";
  if (user.length < 8) return false;
  if (/^\/(raw|build)\b/.test(user)) return false;
  return true;
}
