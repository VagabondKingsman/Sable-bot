/**
 * Learned memory, one store per server process (globalThis singleton).
 * SABLE_MEMORY=0 turns it off entirely (overrides the UI switch).
 * Writes come only from: the interactive chat (memory_save / memory_forget and
 * post-turn extraction), and the user's own edits in the Memory panel.
 * Background jobs, routines and channels can only read.
 */
import { runAgent } from "@/lib/agent/loop";
import { MAX_LEARNED } from "@/lib/agent/assemble";
import { buildExtractPrompt, EXTRACT_SYSTEM, EXTRACT_WINDOW, parseExtraction, worthExtracting, type ExtractMsg } from "@/lib/agent/memory/extract";
import { memoryBlock } from "@/lib/agent/memory/rank";
import { MemoryStore } from "@/lib/agent/memory/store";
import type { MemorySource } from "@/lib/agent/memory/types";
import type { MemoryAccess } from "@/lib/agent/tools/types";
import type { ChatRequest } from "@/lib/agent/types";

const KEY = Symbol.for("sable.memory.store.v1");

export function memoryKillSwitch() {
  return (process.env.SABLE_MEMORY ?? "1").trim() === "0";
}

export function memoryStore(dir: string): MemoryStore {
  const scope = globalThis as unknown as Record<symbol, { dir: string; store: MemoryStore } | undefined>;
  const hit = scope[KEY];
  if (hit && hit.dir === dir) return hit.store;
  const store = new MemoryStore(dir, {
    max: Number(process.env.SABLE_MEMORY_MAX) || undefined,
    journalDays: Number(process.env.SABLE_MEMORY_JOURNAL_DAYS) || undefined,
  });
  scope[KEY] = { dir, store };
  return store;
}

/** Memory usable this process right now (kill switch + UI switch). */
export function memoryOn(store: MemoryStore) {
  return !memoryKillSwitch() && store.enabled();
}

export function accessFor(store: MemoryStore, canWrite: boolean, source: MemorySource, sourceRef?: string): MemoryAccess {
  return {
    canWrite,
    recall: (query, limit) => {
      const found = store.search(query, Math.min(20, Math.max(1, limit)));
      store.markUsed(found.map((item) => item.id));
      return found.map((item) => ({ id: item.id, kind: item.kind, text: item.text, eventDate: item.eventDate }));
    },
    save: (text, kind, eventDate) => {
      if (!canWrite) return { status: "skipped" };
      const result = store.add({ text, kind, eventDate, source, sourceRef });
      return result.status === "skipped" ? { status: "skipped" } : { status: result.status, text: result.memory.text };
    },
    forget: (query) => (canWrite ? store.forget(query).map((item) => item.text) : []),
  };
}

/** Ranked learned-memory block for the prompt; marks what it used. */
export function learnedFor(store: MemoryStore, input: ChatRequest) {
  const query = input.messages.filter((message) => message.role === "user").slice(-2).map((message) => message.content).join("\n");
  const block = memoryBlock(store.list(), query, MAX_LEARNED);
  if (block.used.length) store.markUsed(block.used);
  return block.text;
}

const EXTRACT_MS = 60_000;
let chain: Promise<unknown> = Promise.resolve();
let pending = 0;

export type ExtractDeps = {
  store: MemoryStore;
  /** Run one prompt with no tools and return the model's text. */
  complete: (system: string, user: string, signal: AbortSignal) => Promise<string>;
  today?: string;
};

/** Learn from one finished exchange. Never throws; returns what changed (for tests/logs). */
export async function extractOnce(deps: ExtractDeps, window: ExtractMsg[], sourceRef?: string) {
  const out = { added: 0, merged: 0, updated: 0, forgotten: 0 };
  const recent = window.slice(-EXTRACT_WINDOW);
  if (!worthExtracting(recent)) return out;
  const query = recent.map((message) => message.content).join("\n");
  const related = deps.store.search(query, 12);
  const today = deps.today ?? new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Saigon" }).format(new Date());
  let raw = "";
  try {
    raw = await deps.complete(EXTRACT_SYSTEM, buildExtractPrompt(recent, related, today), AbortSignal.timeout(EXTRACT_MS));
  } catch {
    return out;
  }
  const plan = parseExtraction(raw, new Set(related.map((item) => item.id)));
  for (const item of plan.add) {
    const result = deps.store.add({ text: item.text, kind: item.kind, eventDate: item.eventDate, tags: item.tags, source: "chat", sourceRef });
    if (result.status === "added") out.added++;
    else if (result.status === "merged") out.merged++;
  }
  for (const item of plan.update) {
    const result = deps.store.update(item.id, { text: item.text });
    if (result && !("error" in result)) out.updated++;
  }
  if (plan.forget.length) out.forgotten = deps.store.remove(plan.forget);
  return out;
}

/** Queue an extraction (serialized, at most 3 waiting; drops the rest). */
export function queueExtraction(deps: ExtractDeps, window: ExtractMsg[], sourceRef?: string) {
  if (pending >= 3) return;
  pending++;
  chain = chain
    .then(() => extractOnce(deps, window, sourceRef))
    .catch(() => undefined)
    .finally(() => {
      pending--;
    });
}

/** complete() built on the normal agent loop, no tools, low effort. */
export function completerFor(prepare: () => import("@/server/chat.server").PreparedTurn | null) {
  return async (system: string, user: string, signal: AbortSignal) => {
    const turn = prepare();
    if (!turn) throw new Error("no model");
    let text = "";
    await runAgent(
      { system, messages: [{ role: "user", content: user }], tools: [], report: [] },
      {
        adapter: turn.adapter,
        transport: turn.transport,
        tools: [],
        ctx: { workspaceDir: "/nonexistent", signal, mode: "background" },
        emit: (event) => {
          if (event.event === "delta") text += event.data.text;
        },
        opts: { ...turn.opts, codeOutputs: false, maxTokens: 1_000 },
        maxSteps: 1,
      },
    );
    return text;
  };
}
