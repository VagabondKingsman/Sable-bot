/**
 * W5 incremental indexer: content-hash per doc → only new/changed docs are re-embedded;
 * docs that disappeared from their store (deleted memory, tombstoned thread, removed canvas
 * or file) are dropped (deletion propagation). Text is redacted BEFORE chunking/embedding.
 */
import { redactSecrets } from "../memory/redact.ts";
import { chunkText } from "./chunk.ts";
import { sha, type Embedder } from "./embed.ts";
import type { Doc } from "./sources.ts";
import type { ChunkMeta, VectorStore } from "./store.ts";

export type SyncReport = { embedder: string; added: number; updated: number; removed: number; unchanged: number; chunks: number; redactions: number; skippedCap: number; ms: number; rebuilt: boolean };

export async function syncIndex(store: VectorStore, embedder: Embedder, docs: Doc[], opts: { chunkChars: number; maxChunks: number; signal?: AbortSignal }): Promise<SyncReport> {
  const t0 = Date.now();
  const rep: SyncReport = { embedder: embedder.id, added: 0, updated: 0, removed: 0, unchanged: 0, chunks: 0, redactions: 0, skippedCap: 0, ms: 0, rebuilt: false };
  if (store.embedder !== embedder.id || (embedder.dim && store.dim !== embedder.dim)) {
    store.reset(embedder.id, embedder.dim);
    rep.rebuilt = true;
  }
  const seen = new Set<string>();
  // Newest first so the cap keeps recent knowledge.
  const ordered = [...docs].sort((a, b) => b.at - a.at);
  for (const doc of ordered) {
    if (opts.signal?.aborted) break;
    if (seen.has(doc.key)) continue;
    seen.add(doc.key);
    const red = redactSecrets(doc.text);
    const title = redactSecrets(doc.title).text;
    rep.redactions += red.hits.length;
    const hash = sha(`${title}\n${red.text}`);
    const prev = store.docHash(doc.key);
    if (prev === hash) {
      rep.unchanged += 1;
      continue;
    }
    const pieces = chunkText(red.text, opts.chunkChars);
    if (store.size + pieces.length > opts.maxChunks + (prev ? pieces.length : 0)) {
      rep.skippedCap += 1;
      if (prev) {
        store.removeDoc(doc.key);
        rep.removed += 1;
      }
      continue;
    }
    if (!pieces.length) {
      if (prev) {
        store.removeDoc(doc.key);
        rep.removed += 1;
      }
      continue;
    }
    const vecs = await embedder.embed(pieces.map((p) => `${title}\n${p}`), opts.signal);
    if (!store.dim) store.reset(embedder.id, vecs[0]!.length);
    const metas: { meta: ChunkMeta; vec: Float32Array }[] = pieces.map((text, i) => ({
      meta: { id: `${sha(doc.key)}:${i}`, doc: doc.key, source: doc.source, title, ref: doc.ref, at: doc.at, text },
      vec: vecs[i]!,
    }));
    store.putDoc(doc.key, hash, doc.source, metas);
    rep.chunks += metas.length;
    if (prev) rep.updated += 1;
    else rep.added += 1;
  }
  if (!opts.signal?.aborted) {
    for (const key of store.docKeys()) {
      if (!seen.has(key)) {
        store.removeDoc(key);
        rep.removed += 1;
      }
    }
  }
  store.save();
  rep.ms = Date.now() - t0;
  return rep;
}
