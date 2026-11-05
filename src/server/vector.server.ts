/**
 * W5 (D4) local vector store server: one in-process index under dataDir/vector, incremental
 * sync (lazy before search when stale + periodic ticker), deletion propagation, redaction before
 * embedding, vault never indexed. Kill switch SABLE_VECTOR=0 (no index, no ticker, recall falls
 * back to BM25-only memory search).
 */
import { vectorConfig, type VectorConfig } from "@/lib/agent/vector/config";
import { VectorStore, type ChunkMeta } from "@/lib/agent/vector/store";
import { collectAll } from "@/lib/agent/vector/sources";
import { syncIndex, type SyncReport } from "@/lib/agent/vector/indexer";
import { pickEmbedder, type Picked } from "@/lib/agent/vector/select";
import { Bm25Index, hybridRank, packHits, type Hit, type Mode } from "@/lib/agent/vector/hybrid";
import type { SourceKind } from "@/lib/agent/vector/store";
import { dataDir, workspaceDir } from "@/server/paths";

type State = {
  cfg: VectorConfig;
  store: VectorStore | null;
  picked: Promise<Picked> | null;
  pickedNow: Picked | null;
  syncing: Promise<SyncReport | null> | null;
  last: SyncReport | null;
  lastAt: number;
  lastError: string;
  timer: ReturnType<typeof setInterval> | null;
};
const KEY = Symbol.for("sable.vector.v1");
function st(): State {
  const g = globalThis as unknown as Record<symbol, State | undefined>;
  if (!g[KEY]) {
    const cfg = { ...vectorConfig(), workspaceRoot: workspaceDir() };
    g[KEY] = { cfg: { ...cfg, dir: `${dataDir()}/vector` }, store: null, picked: null, pickedNow: null, syncing: null, last: null, lastAt: 0, lastError: "", timer: null };
  }
  return g[KEY]!;
}

export function vectorOn() {
  return process.env.SABLE_VECTOR !== "0";
}

function store(): VectorStore {
  const s = st();
  return (s.store ??= new VectorStore(s.cfg.dir));
}

export async function embedder(): Promise<Picked> {
  const s = st();
  s.picked ??= pickEmbedder(s.cfg, process.env).then((p) => {
    s.pickedNow = p;
    console.log(`[sable-vector] embedder: ${p.embedder.id}`);
    return p;
  });
  return s.picked;
}

/** Incremental sync (single flight). */
export async function syncVector(signal?: AbortSignal): Promise<SyncReport | null> {
  if (!vectorOn()) return null;
  const s = st();
  if (s.syncing) return s.syncing;
  s.syncing = (async () => {
    try {
      const { embedder: e } = await embedder();
      const docs = collectAll(dataDir(), s.cfg.workspaceRoot);
      const rep = await syncIndex(store(), e, docs, { chunkChars: s.cfg.chunkChars, maxChunks: s.cfg.maxChunks, signal });
      s.last = rep;
      s.lastAt = Date.now();
      s.lastError = "";
      if (rep.added || rep.updated || rep.removed) console.log(`[sable-vector] sync +${rep.added} ~${rep.updated} -${rep.removed} (${rep.chunks} chunks, ${rep.ms}ms)`);
      return rep;
    } catch (error) {
      s.lastError = error instanceof Error ? error.message.slice(0, 200) : "sync failed";
      s.lastAt = Date.now();
      return null;
    } finally {
      s.syncing = null;
    }
  })();
  return s.syncing;
}

/** Sync first when the index is older than maxAgeMs (cheap: unchanged docs are hash-skipped). */
export async function freshVector(maxAgeMs = 60_000) {
  if (!vectorOn()) return;
  const s = st();
  if (Date.now() - s.lastAt > maxAgeMs) await syncVector();
}

export function startVectorTicker() {
  const s = st();
  if (!vectorOn() || s.timer) return;
  setTimeout(() => void syncVector(), 20_000).unref?.();
  s.timer = setInterval(() => void syncVector(), s.cfg.syncMin * 60_000);
  s.timer.unref?.();
}

export async function embedQuery(text: string): Promise<Float32Array | null> {
  try {
    const { embedder: e } = await embedder();
    const [v] = await e.embed([text]);
    return v ?? null;
  } catch {
    return null;
  }
}

/** Vector-only search (hybrid lives in recall). */
export async function vectorSearch(query: string, k = 8, filter?: (c: ChunkMeta) => boolean) {
  if (!vectorOn()) return [];
  await freshVector();
  const q = await embedQuery(query);
  return q ? store().search(q, k, filter) : [];
}

export function vectorIndex() {
  return vectorOn() ? store() : null;
}

export function vectorStatus() {
  const s = st();
  const on = vectorOn();
  return {
    enabled: on,
    embedder: s.pickedNow?.embedder.id ?? null,
    embedderKind: s.pickedNow?.embedder.kind ?? null,
    tried: s.pickedNow?.tried ?? [],
    provider: s.cfg.provider,
    stats: on ? store().stats() : null,
    last: s.last,
    lastAt: s.lastAt || null,
    lastError: s.lastError || null,
    syncing: Boolean(s.syncing),
    maxChunks: s.cfg.maxChunks,
    syncMin: s.cfg.syncMin,
    recallTokens: s.cfg.recallTokens,
  };
}

export function clearVector() {
  const s = st();
  store().clear();
  s.lastAt = 0;
  s.last = null;
}

export function recallTokenBudget() {
  return st().cfg.recallTokens;
}

// ── W5 item 2: hybrid retrieval ──────────────────────────────────────────────

let bmCache: { version: number; index: Bm25Index } | null = null;
function bm25Index(): Bm25Index {
  const st0 = store();
  if (!bmCache || bmCache.version !== st0.version) bmCache = { version: st0.version, index: new Bm25Index(st0.chunks()) };
  return bmCache.index;
}

export type RecallOpts = { k?: number; sources?: SourceKind[]; excludeDocs?: string[]; mode?: Mode; fresh?: boolean };

/** BM25 + vector + recency over the local index. [] when SABLE_VECTOR=0. */
export async function hybridSearch(query: string, opts: RecallOpts = {}): Promise<Hit[]> {
  if (!vectorOn() || !query.trim()) return [];
  if (opts.fresh !== false) await freshVector();
  const q = opts.mode === "bm25" ? null : await embedQuery(query);
  const s = store();
  const want = opts.sources?.length ? new Set(opts.sources) : null;
  const ex = new Set(opts.excludeDocs ?? []);
  const filter = (c: { source: SourceKind; doc: string }) => (!want || want.has(c.source)) && !ex.has(c.doc);
  return hybridRank(bm25Index(), query, q ? (ids) => s.scoreIds(q, ids) : null, { mode: opts.mode ?? "hybrid", k: opts.k ?? 8, filter, vecTop: q ? (k) => s.search(q, k, filter) : undefined });
}

/** Context-builder recall block: other threads, pages, research, workspace docs (memory/journal are in the learned block). */
export async function recallBlockFor(query: string, threadId?: string, timeoutMs = 2_500): Promise<string> {
  if (!vectorOn() || process.env.SABLE_RECALL_CONTEXT === "0" || recallTokenBudget() <= 0 || !query.trim()) return "";
  try {
    const hits = await Promise.race([
      hybridSearch(query, { k: 6, sources: ["thread", "canvas", "research", "workspace"], excludeDocs: threadId ? [`thread:${threadId}`] : [], fresh: false }),
      new Promise<Hit[]>((resolve) => setTimeout(() => resolve([]), timeoutMs).unref?.()),
    ]);
    // Only reasonably relevant hits go into the prompt.
    return packHits(hits.filter((h) => h.score >= 0.25), recallTokenBudget()).text;
  } catch {
    return "";
  }
}
