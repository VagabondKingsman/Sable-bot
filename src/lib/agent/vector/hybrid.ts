/**
 * W5 hybrid retrieval: BM25 (inverted index over folded tokens, prefix match ≥4 chars, same
 * tokenizer as memory recall) + vector cosine + recency, each normalised to 0..1 and weighted.
 * Recency only re-orders relevant hits (it can never surface an unrelated chunk on its own).
 * Results are packed into a token budget (≈4 chars/token) with ≤2 chunks per doc.
 */
import { tokenize } from "../memory/rank.ts";
import type { ChunkMeta, SourceKind } from "./store.ts";

export type Weights = { bm25: number; vector: number; recency: number };
export const DEFAULT_WEIGHTS: Weights = { bm25: 0.45, vector: 0.4, recency: 0.15 };
export type Hit = { chunk: ChunkMeta; score: number; parts: { bm25: number; vector: number; recency: number } };
export type Mode = "hybrid" | "bm25" | "vector";

type Posting = { i: number; tf: number };
export class Bm25Index {
  readonly chunks: ChunkMeta[];
  private post = new Map<string, Posting[]>();
  private len: number[] = [];
  private avg = 1;
  constructor(chunks: ChunkMeta[]) {
    this.chunks = chunks;
    chunks.forEach((c, i) => {
      const toks = tokenize(`${c.title} ${c.text}`);
      this.len.push(toks.length);
      const tf = new Map<string, number>();
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const [t, n] of tf) {
        let p = this.post.get(t);
        if (!p) this.post.set(t, (p = []));
        p.push({ i, tf: n });
      }
    });
    this.avg = this.len.reduce((a, b) => a + b, 0) / (chunks.length || 1) || 1;
  }
  /** chunk index → bm25 score (only matching chunks). */
  score(query: string): Map<number, number> {
    const out = new Map<number, number>();
    const N = this.chunks.length || 1;
    for (const term of new Set(tokenize(query))) {
      const keys = term.length >= 4 ? [...this.post.keys()].filter((k) => k === term || k.startsWith(term)) : this.post.has(term) ? [term] : [];
      const merged = new Map<number, number>();
      for (const k of keys) for (const p of this.post.get(k)!) merged.set(p.i, (merged.get(p.i) ?? 0) + p.tf);
      if (!merged.size) continue;
      const idf = Math.log(1 + (N - merged.size + 0.5) / (merged.size + 0.5));
      for (const [i, f] of merged) out.set(i, (out.get(i) ?? 0) + idf * ((f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (this.len[i]! / this.avg)))));
    }
    return out;
  }
}

const DAY = 86_400_000;
export const recencyScore = (at: number, now: number, halfLifeDays = 30) => (at > 0 ? 1 / (1 + Math.max(0, now - at) / DAY / halfLifeDays) : 0);

export function hybridRank(
  index: Bm25Index,
  query: string,
  vecScore: ((ids: string[]) => Map<string, number>) | null,
  opts: { mode?: Mode; k?: number; now?: number; weights?: Weights; filter?: (c: ChunkMeta) => boolean; vecTop?: (k: number) => { chunk: ChunkMeta; score: number }[] } = {},
): Hit[] {
  const mode = opts.mode ?? "hybrid";
  const w = opts.weights ?? DEFAULT_WEIGHTS;
  const now = opts.now ?? Date.now();
  const k = opts.k ?? 8;
  const filter = opts.filter ?? (() => true);
  const bm = mode === "vector" ? new Map<number, number>() : index.score(query);
  const cand = new Map<string, { chunk: ChunkMeta; b: number; v: number }>();
  for (const [i, s] of bm) {
    const c = index.chunks[i]!;
    if (filter(c)) cand.set(c.id, { chunk: c, b: s, v: 0 });
  }
  if (mode !== "bm25" && opts.vecTop) {
    for (const r of opts.vecTop(Math.max(50, k * 6))) if (filter(r.chunk) && !cand.has(r.chunk.id)) cand.set(r.chunk.id, { chunk: r.chunk, b: 0, v: r.score });
  }
  if (mode !== "bm25" && vecScore) {
    const vs = vecScore([...cand.keys()]);
    for (const [id, s] of vs) cand.get(id)!.v = s;
  }
  const maxB = Math.max(0, ...[...cand.values()].map((c) => c.b)) || 1;
  const maxV = Math.max(0, ...[...cand.values()].map((c) => c.v)) || 1;
  const wb = mode === "vector" ? 0 : w.bm25;
  const wv = mode === "bm25" ? 0 : w.vector;
  const hits: Hit[] = [];
  for (const c of cand.values()) {
    const b = c.b / maxB;
    const v = Math.max(0, c.v) / maxV;
    // Relevance gate: lexical match, or a vector score that is both strong in absolute terms and near the best.
    const vecOk = c.v >= 0.12 && v >= 0.55;
    if (!(c.b > 0 || (wv > 0 && vecOk))) continue;
    const rel = (wb * b + wv * (vecOk || c.b > 0 ? v : 0)) / ((wb + wv) || 1);
    const r = recencyScore(c.chunk.at, now);
    hits.push({ chunk: c.chunk, score: rel * (1 - w.recency) + w.recency * r * rel, parts: { bm25: b, vector: v, recency: r } });
  }
  hits.sort((a, b) => b.score - a.score);
  // ≤2 chunks per doc keeps results diverse.
  const perDoc = new Map<string, number>();
  const out: Hit[] = [];
  for (const h of hits) {
    const n = perDoc.get(h.chunk.doc) ?? 0;
    if (n >= 2) continue;
    perDoc.set(h.chunk.doc, n + 1);
    out.push(h);
    if (out.length >= k) break;
  }
  return out;
}

const LABEL: Record<SourceKind, string> = { memory: "ghi nhớ", journal: "nhật ký", thread: "trò chuyện", canvas: "trang", research: "nghiên cứu", workspace: "tệp" };

/** Pack hits into ≈tokens*4 chars; each line "[nguồn · tiêu đề · ngày] đoạn trích". */
export function packHits(hits: Hit[], tokens: number, snippet = 420): { text: string; used: Hit[] } {
  const max = Math.max(0, tokens) * 4;
  const lines: string[] = [];
  const used: Hit[] = [];
  let size = 0;
  for (const h of hits) {
    const date = h.chunk.at > 0 ? new Date(h.chunk.at).toISOString().slice(0, 10) : "";
    const body = h.chunk.text.replace(/\s+/g, " ").trim();
    const line = `- [${LABEL[h.chunk.source]} · ${h.chunk.title.slice(0, 80)}${date ? ` · ${date}` : ""}] ${body.length > snippet ? `${body.slice(0, snippet)}…` : body}`;
    if (size + line.length + 1 > max) {
      if (!lines.length && max > 80) {
        lines.push(line.slice(0, max - 1));
        used.push(h);
      }
      break;
    }
    lines.push(line);
    used.push(h);
    size += line.length + 1;
  }
  return { text: lines.join("\n"), used };
}
