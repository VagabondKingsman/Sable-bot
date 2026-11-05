/**
 * field-journal → Sable memory (kind=journal).
 * After a task, write lesson/trap/workaround; recall on similar hints.
 * Adapted idea from reverse-skill field-journal (MIT) — anonymized entries only.
 */
import type { MemoryStore } from "../memory/store.ts";
import { redactSecrets } from "../memory/redact.ts";

export type JournalLesson = {
  scenario: string;
  lesson: string;
  trap?: string;
  workaround?: string;
  routeId?: string;
  skill?: string;
  eventDate?: string;
};

export const FIELD_JOURNAL_PREFIX = "[field-journal]";

export function formatLesson(entry: JournalLesson): string {
  return [
    FIELD_JOURNAL_PREFIX,
    `scenario=${entry.scenario.slice(0, 80)}`,
    entry.routeId ? `route=${entry.routeId}` : null,
    entry.skill ? `skill=${entry.skill}` : null,
    `lesson=${entry.lesson.slice(0, 500)}`,
    entry.trap ? `trap=${entry.trap.slice(0, 300)}` : null,
    entry.workaround ? `workaround=${entry.workaround.slice(0, 300)}` : null,
  ]
    .filter(Boolean)
    .join(" | ");
}

export function writeLesson(
  memory: MemoryStore,
  entry: JournalLesson,
): { ok: true; id: string; text: string; status: string } | { ok: false; error: string } {
  if (!memory.enabled()) return { ok: false, error: "memory off" };
  const { text } = redactSecrets(formatLesson(entry));
  const result = memory.add({
    text,
    kind: "journal",
    source: "tool",
    eventDate: entry.eventDate,
    tags: ["field-journal", entry.scenario.slice(0, 24)],
  });
  if (result.status === "skipped") return { ok: false, error: result.reason };
  return { ok: true, id: result.memory.id, text: result.memory.text, status: result.status };
}

export function recallLessons(memory: MemoryStore, hint: string, limit = 5) {
  const ranked = memory.search(`${FIELD_JOURNAL_PREFIX} ${hint}`.slice(0, 200), Math.max(limit * 3, 15));
  return ranked.filter((item) => item.kind === "journal" && item.text.includes(FIELD_JOURNAL_PREFIX)).slice(0, limit);
}
