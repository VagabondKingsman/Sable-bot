/**
 * Relevance for learned memories: BM25 over folded tokens (Vietnamese
 * diacritics folded so "cà phê" matches "ca phe"), plus small boosts for
 * recency and use. No vectors, no network.
 */
import type { Memory } from "./types.ts";

const STOP = new Set(
  (
    "the a an and or of to in on at for is are was be it this that with as by from my me i you your we our " +
    "va la cua cho voi cac nhung mot nay do thi ma o tai tu den khi neu de duoc co khong toi ban minh anh em " +
    "gi nao sao the nhe a oi roi se dang da"
  ).split(" "),
);

export function fold(text: string) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d");
}

export function tokenize(text: string): string[] {
  return fold(text)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && !STOP.has(token));
}

export type Scored = { memory: Memory; score: number };

/** BM25 (k1=1.2, b=0.75) of each memory against the query; 0 when nothing matches. */
export function bm25(memories: Memory[], query: string): Scored[] {
  const terms = [...new Set(tokenize(query))];
  const docs = memories.map((memory) => tokenize(`${memory.text} ${memory.tags.join(" ")}`));
  const count = docs.length || 1;
  const avg = docs.reduce((sum, doc) => sum + doc.length, 0) / count || 1;
  const df = new Map<string, number>();
  for (const doc of docs) for (const term of new Set(doc)) df.set(term, (df.get(term) ?? 0) + 1);
  return memories.map((memory, index) => {
    const doc = docs[index];
    let score = 0;
    for (const term of terms) {
      const freq = doc.filter((token) => token === term || (term.length >= 4 && token.startsWith(term))).length;
      if (!freq) continue;
      const n = df.get(term) ?? 1;
      const idf = Math.log(1 + (count - n + 0.5) / (n + 0.5));
      score += idf * ((freq * 2.2) / (freq + 1.2 * (0.25 + 0.75 * (doc.length / avg))));
    }
    return { memory, score };
  });
}

const DAY = 86_400_000;

/** Search order for the UI and the recall tool: relevance first, then recency. */
export function search(memories: Memory[], query: string, now = Date.now()): Scored[] {
  if (!query.trim()) return [...memories].sort((a, b) => b.updatedAt - a.updatedAt).map((memory) => ({ memory, score: 0 }));
  return bm25(memories, query)
    .filter((item) => item.score > 0 || fold(item.memory.text).includes(fold(query.trim())))
    .map((item) => ({ ...item, score: item.score + recency(item.memory, now) * 0.3 }))
    .sort((a, b) => b.score - a.score);
}

function recency(memory: Memory, now: number) {
  const age = Math.max(0, now - memory.updatedAt) / DAY;
  return 1 / (1 + age / 14);
}

export type MemoryBlock = { text: string; used: string[]; clipped: boolean };

/**
 * What gets injected into the system prompt, within `budget` characters:
 * pinned, then profile facts (most-used / newest first), then journal entries
 * that match the query, then the few newest journal entries if room is left.
 */
export function memoryBlock(memories: Memory[], query: string, budget: number, now = Date.now()): MemoryBlock {
  const pinned = memories.filter((m) => m.pinned);
  const profile = memories
    .filter((m) => !m.pinned && m.kind === "profile")
    .map((memory) => ({ memory, score: bm25([memory], query)[0].score }))
    .sort((a, b) => b.score - a.score || b.memory.hits - a.memory.hits || b.memory.updatedAt - a.memory.updatedAt)
    .map((item) => item.memory);
  const journalAll = memories.filter((m) => !m.pinned && m.kind === "journal");
  const scored = bm25(journalAll, query);
  const relevant = scored
    .filter((item) => item.score > 0)
    .map((item) => ({ ...item, score: item.score + recency(item.memory, now) * 0.5 + Math.min(item.memory.hits, 20) * 0.02 }))
    .sort((a, b) => b.score - a.score)
    .map((item) => item.memory);
  const recent = journalAll
    .filter((m) => !relevant.includes(m) && now - m.updatedAt < 30 * DAY)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 3);
  const order = [...pinned, ...profile, ...relevant, ...recent];
  const lines: string[] = [];
  const used: string[] = [];
  let size = 0;
  let clipped = false;
  for (const memory of order) {
    const date = memory.kind === "journal" && memory.eventDate ? ` (${memory.eventDate})` : "";
    const line = `- ${memory.text}${date}`;
    if (size + line.length + 1 > budget) {
      clipped = true;
      continue;
    }
    lines.push(line);
    used.push(memory.id);
    size += line.length + 1;
  }
  return { text: lines.join("\n"), used, clipped };
}
