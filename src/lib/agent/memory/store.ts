/**
 * File-backed learned memory (`memory.json` in the data dir, outside the web
 * root and the fs-tool jail). Single process, single user: the in-memory copy
 * is the truth, every change is written atomically. Every text goes through
 * `sanitizeMemoryText` (secret redaction) on the way in, from any source.
 */
import fs from "node:fs";
import path from "node:path";
import { writeAtomic } from "../jobs/db.ts";
import { fold, search, tokenize } from "./rank.ts";
import { sanitizeMemoryText } from "./redact.ts";
import { MAX_MEMORY_TEXT, MEMORY_KINDS, MEMORY_SOURCES, type Memory, type MemoryFile, type MemoryKind, type MemorySource } from "./types.ts";

export const DEFAULT_MAX_MEMORIES = 500;
export const DEFAULT_JOURNAL_DAYS = 365;
const MAX_TAGS = 6;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^mem_[A-Za-z0-9_]{4,40}$/;

export type AddInput = {
  text: string;
  kind?: MemoryKind;
  source: MemorySource;
  sourceRef?: string;
  tags?: string[];
  pinned?: boolean;
  eventDate?: string;
};

export type AddResult =
  | { status: "added" | "merged"; memory: Memory }
  | { status: "skipped"; reason: "empty_or_secret" | "disabled" };

export type Patch = { text?: string; kind?: MemoryKind; pinned?: boolean; tags?: string[]; eventDate?: string | null };

function newId() {
  return `mem_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function trigrams(text: string) {
  const norm = ` ${tokenize(text).join(" ")} `;
  const set = new Set<string>();
  for (let index = 0; index + 3 <= norm.length; index += 1) set.add(norm.slice(index, index + 3));
  return set;
}

/** Dice coefficient over character trigrams of the folded, stop-word-free text. */
export function similarity(a: string, b: string) {
  if (fold(a).trim() === fold(b).trim()) return 1;
  const left = trigrams(a);
  const right = trigrams(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const gram of left) if (right.has(gram)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}

export const DUPLICATE_AT = 0.8;

function cleanTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const tag of raw) {
    if (typeof tag !== "string") continue;
    const value = fold(tag).replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
    if (value && !out.includes(value)) out.push(value);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

function cleanDate(raw: unknown): string | undefined {
  return typeof raw === "string" && DATE_RE.test(raw.trim()) ? raw.trim() : undefined;
}

export function isMemoryShape(value: unknown): value is Memory {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    ID_RE.test(item.id) &&
    typeof item.text === "string" &&
    MEMORY_KINDS.includes(item.kind as MemoryKind) &&
    MEMORY_SOURCES.includes(item.source as MemorySource) &&
    typeof item.createdAt === "number" &&
    typeof item.updatedAt === "number"
  );
}

export type StoreOptions = { max?: number; journalDays?: number; now?: () => number };

export class MemoryStore {
  private data: MemoryFile | null = null;
  private readonly file: string;
  private readonly max: number;
  private readonly journalMs: number;
  private readonly now: () => number;

  constructor(dir: string, options: StoreOptions = {}) {
    this.file = path.join(dir, "memory.json");
    this.max = Math.max(10, options.max ?? DEFAULT_MAX_MEMORIES);
    this.journalMs = Math.max(1, options.journalDays ?? DEFAULT_JOURNAL_DAYS) * 86_400_000;
    this.now = options.now ?? (() => Date.now());
  }

  private load(): MemoryFile {
    if (this.data) return this.data;
    let parsed: MemoryFile = { version: 1, enabled: true, items: [] };
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<MemoryFile>;
      parsed = {
        version: 1,
        enabled: raw.enabled !== false,
        items: Array.isArray(raw.items) ? raw.items.filter(isMemoryShape).map(normalize) : [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        try {
          fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
          console.warn("[sable-memory] unreadable memory.json set aside");
        } catch {
          /* nothing to keep */
        }
      }
    }
    this.data = parsed;
    return parsed;
  }

  private save(next: MemoryFile) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    writeAtomic(this.file, JSON.stringify(next));
    this.data = next;
  }

  enabled() {
    return this.load().enabled;
  }

  setEnabled(enabled: boolean) {
    this.save({ ...this.load(), enabled });
  }

  list(): Memory[] {
    return [...this.load().items].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
  }

  get(id: string) {
    return this.load().items.find((item) => item.id === id);
  }

  search(query: string, limit = 50) {
    return search(this.load().items, query, this.now()).slice(0, limit).map((item) => item.memory);
  }

  /** Closest existing memory if it is a near-duplicate of `text`. */
  findDuplicate(text: string, except?: string) {
    let best: { memory: Memory; score: number } | null = null;
    for (const memory of this.load().items) {
      if (memory.id === except) continue;
      const score = similarity(memory.text, text);
      if (score >= DUPLICATE_AT && (!best || score > best.score)) best = { memory, score };
    }
    return best?.memory;
  }

  add(input: AddInput): AddResult {
    const text = sanitizeMemoryText(input.text, MAX_MEMORY_TEXT);
    if (!text) return { status: "skipped", reason: "empty_or_secret" };
    const now = this.now();
    const data = this.load();
    const kind: MemoryKind = input.kind === "journal" ? "journal" : "profile";
    const duplicate = this.findDuplicate(text);
    if (duplicate) {
      // Newer wording wins (a changed preference supersedes the old one); keep id, pin, hits.
      const merged: Memory = {
        ...duplicate,
        text,
        kind: duplicate.kind === "profile" || kind === "profile" ? "profile" : "journal",
        tags: cleanTags([...duplicate.tags, ...(input.tags ?? [])]),
        pinned: duplicate.pinned || Boolean(input.pinned),
        eventDate: cleanDate(input.eventDate) ?? duplicate.eventDate,
        source: input.source === "user" ? "user" : duplicate.source,
        updatedAt: now,
      };
      this.commit(data.items.map((item) => (item.id === duplicate.id ? merged : item)));
      return { status: "merged", memory: merged };
    }
    const memory: Memory = {
      id: newId(),
      kind,
      text,
      tags: cleanTags(input.tags),
      source: input.source,
      sourceRef: typeof input.sourceRef === "string" ? input.sourceRef.slice(0, 80) : undefined,
      pinned: Boolean(input.pinned),
      eventDate: kind === "journal" ? cleanDate(input.eventDate) : undefined,
      createdAt: now,
      updatedAt: now,
      hits: 0,
    };
    this.commit([memory, ...data.items]);
    return { status: "added", memory };
  }

  update(id: string, patch: Patch): Memory | { error: string } | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const next: Memory = { ...current, updatedAt: this.now() };
    if (patch.text !== undefined) {
      const text = sanitizeMemoryText(patch.text, MAX_MEMORY_TEXT);
      if (!text) return { error: "Nội dung trống hoặc chứa thông tin bí mật (mật khẩu, khóa, số thẻ) nên không lưu." };
      next.text = text;
    }
    if (patch.kind !== undefined) next.kind = patch.kind === "journal" ? "journal" : "profile";
    if (patch.pinned !== undefined) next.pinned = Boolean(patch.pinned);
    if (patch.tags !== undefined) next.tags = cleanTags(patch.tags);
    if (patch.eventDate !== undefined) next.eventDate = patch.eventDate === null ? undefined : cleanDate(patch.eventDate);
    if (next.kind === "profile") next.eventDate = undefined;
    this.commit(this.load().items.map((item) => (item.id === id ? next : item)));
    return next;
  }

  remove(ids: string[] | "all") {
    const items = this.load().items;
    const set = ids === "all" ? null : new Set(ids);
    const kept = items.filter((item) => set && !set.has(item.id));
    const removed = items.length - kept.length;
    if (removed) this.commit(kept);
    return removed;
  }

  /**
   * Forget what matches `query`: memories whose text contains it, else the
   * strongest BM25 matches (within 60 % of the best score), at most `limit`.
   */
  forget(query: string, limit = 5): Memory[] {
    const needle = fold(query.trim());
    if (needle.length < 2) return [];
    const items = this.load().items;
    let hits = items.filter((item) => fold(item.text).includes(needle));
    if (!hits.length) {
      const ranked = search(items, query, this.now()).filter((item) => item.score > 0);
      const top = ranked[0]?.score ?? 0;
      hits = ranked.filter((item) => item.score >= top * 0.6 && item.score >= 0.5).map((item) => item.memory);
    }
    hits = hits.slice(0, limit);
    if (hits.length) this.remove(hits.map((item) => item.id));
    return hits;
  }

  markUsed(ids: string[]) {
    if (!ids.length) return;
    const now = this.now();
    const set = new Set(ids);
    const data = this.load();
    // Usage counters are bookkeeping: written without re-running retention.
    this.save({ ...data, items: data.items.map((item) => (set.has(item.id) ? { ...item, hits: item.hits + 1, lastUsedAt: now } : item)) });
  }

  /** Import a JSON export (or a bare array). Every entry is re-validated and re-redacted. */
  importItems(raw: unknown, mode: "merge" | "replace" = "merge") {
    const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as MemoryFile).items) ? (raw as MemoryFile).items : null;
    if (!list) return { error: "File không đúng định dạng xuất của Sable." } as const;
    if (list.length > this.max * 2) return { error: `Tối đa ${this.max * 2} mục mỗi lần nhập.` } as const;
    if (mode === "replace") {
      // Never wipe for a file with nothing importable in it.
      if (!list.some((entry) => entry && typeof entry === "object" && typeof (entry as { text?: unknown }).text === "string")) return { error: "File không có mục nào để nhập." } as const;
      this.commit([]);
    }
    let added = 0;
    let merged = 0;
    let skipped = 0;
    for (const entry of list) {
      const item = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : null;
      if (!item || typeof item.text !== "string") {
        skipped += 1;
        continue;
      }
      const result = this.add({
        text: item.text,
        kind: item.kind === "journal" ? "journal" : "profile",
        source: "import",
        tags: Array.isArray(item.tags) ? (item.tags as string[]) : [],
        pinned: item.pinned === true,
        eventDate: typeof item.eventDate === "string" ? item.eventDate : undefined,
      });
      if (result.status === "added") added += 1;
      else if (result.status === "merged") merged += 1;
      else skipped += 1;
    }
    return { added, merged, skipped } as const;
  }

  exportFile(): MemoryFile {
    const data = this.load();
    return { version: 1, enabled: data.enabled, items: this.list() };
  }

  /** Retention + size cap, then save. */
  private commit(items: Memory[]) {
    const now = this.now();
    let kept = items.filter(
      (item) => item.pinned || item.kind === "profile" || now - Math.max(item.updatedAt, item.lastUsedAt ?? 0) < this.journalMs,
    );
    if (kept.length > this.max) {
      const value = (item: Memory) => Math.max(item.updatedAt, item.lastUsedAt ?? 0) + Math.min(item.hits, 50) * 86_400_000;
      const evictable = kept
        .filter((item) => !item.pinned)
        .sort((a, b) => (a.kind === b.kind ? value(a) - value(b) : a.kind === "journal" ? -1 : 1));
      const drop = new Set(evictable.slice(0, kept.length - this.max).map((item) => item.id));
      kept = kept.filter((item) => !drop.has(item.id));
    }
    this.save({ ...this.load(), items: kept });
  }

  stats() {
    const items = this.load().items;
    return {
      total: items.length,
      profile: items.filter((item) => item.kind === "profile").length,
      journal: items.filter((item) => item.kind === "journal").length,
      pinned: items.filter((item) => item.pinned).length,
      max: this.max,
    };
  }
}

function normalize(item: Memory): Memory {
  return {
    ...item,
    tags: cleanTags(item.tags),
    pinned: item.pinned === true,
    hits: typeof item.hits === "number" && Number.isFinite(item.hits) ? item.hits : 0,
    eventDate: cleanDate(item.eventDate),
  };
}
