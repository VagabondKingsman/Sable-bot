/**
 * W5 flat local vector store (no ANN graph: exact cosine over int8-quantised rows; at personal
 * scale ≤ ~20k chunks this is a few ms and the lightest option on RAM — 512-d ≈ 0.5 KB/chunk).
 * Persisted under <dataDir>/vector/: meta.json (docs + chunk text, redacted) + vectors.bin
 * (per row: float32 scale + int8[dim]), atomic writes, mode 0600.
 */
import fs from "node:fs";
import path from "node:path";

export type SourceKind = "memory" | "journal" | "thread" | "canvas" | "research" | "workspace";
export const SOURCE_KINDS: readonly SourceKind[] = ["memory", "journal", "thread", "canvas", "research", "workspace"];

export type ChunkMeta = { id: string; doc: string; source: SourceKind; title: string; ref: string; at: number; text: string };
export type DocMeta = { hash: string; source: SourceKind; chunks: string[] };
type Row = { meta: ChunkMeta; q: Int8Array; scale: number };

export type StoreStats = { embedder: string; dim: number; docs: number; chunks: number; bySource: Record<string, number>; bytes: number; updatedAt: number };

const META = "meta.json";
const BIN = "vectors.bin";

function writeAtomic(file: string, data: string | Buffer) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function quantize(v: Float32Array): { q: Int8Array; scale: number } {
  let max = 0;
  for (const x of v) max = Math.max(max, Math.abs(x));
  const scale = max / 127 || 1;
  const q = new Int8Array(v.length);
  for (let i = 0; i < v.length; i += 1) q[i] = Math.round(v[i]! / scale);
  return { q, scale };
}

export class VectorStore {
  readonly dir: string;
  embedder = "";
  dim = 0;
  updatedAt = 0;
  private rows = new Map<string, Row>();
  private docs = new Map<string, DocMeta>();
  private dirty = false;
  /** Bumped on every mutation (BM25 index cache key). */
  version = 0;

  constructor(dir: string) {
    this.dir = dir;
    this.load();
  }

  private load() {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(this.dir, META), "utf8")) as { version: number; embedder: string; dim: number; updatedAt: number; docs: Record<string, DocMeta>; chunks: ChunkMeta[] };
      const bin = fs.readFileSync(path.join(this.dir, BIN));
      const stride = 4 + meta.dim;
      if (meta.version !== 1 || bin.length !== meta.chunks.length * stride) throw new Error("mismatch");
      this.embedder = meta.embedder;
      this.dim = meta.dim;
      this.updatedAt = meta.updatedAt ?? 0;
      meta.chunks.forEach((c, i) => {
        const off = i * stride;
        const scale = bin.readFloatLE(off);
        const q = new Int8Array(meta.dim);
        for (let k = 0; k < meta.dim; k += 1) q[k] = bin.readInt8(off + 4 + k);
        this.rows.set(c.id, { meta: c, q, scale });
      });
      for (const [k, d] of Object.entries(meta.docs ?? {})) this.docs.set(k, d);
    } catch {
      this.rows.clear();
      this.docs.clear();
    }
  }

  /** Embedder changed (or dim) → drop everything; the indexer rebuilds. */
  reset(embedder: string, dim: number) {
    this.rows.clear();
    this.docs.clear();
    this.embedder = embedder;
    this.dim = dim;
    this.dirty = true;
    this.version += 1;
  }

  docHash(key: string) {
    return this.docs.get(key)?.hash;
  }
  docKeys() {
    return [...this.docs.keys()];
  }
  get size() {
    return this.rows.size;
  }

  removeDoc(key: string) {
    const d = this.docs.get(key);
    if (!d) return 0;
    for (const id of d.chunks) this.rows.delete(id);
    this.docs.delete(key);
    this.dirty = true;
    this.version += 1;
    return d.chunks.length;
  }

  putDoc(key: string, hash: string, source: SourceKind, chunks: { meta: ChunkMeta; vec: Float32Array }[]) {
    this.removeDoc(key);
    for (const c of chunks) {
      if (c.vec.length !== this.dim) throw new Error(`dim ${c.vec.length} ≠ ${this.dim}`);
      const { q, scale } = quantize(c.vec);
      this.rows.set(c.meta.id, { meta: c.meta, q, scale });
    }
    this.docs.set(key, { hash, source, chunks: chunks.map((c) => c.meta.id) });
    this.dirty = true;
    this.version += 1;
  }

  chunks(): ChunkMeta[] {
    return [...this.rows.values()].map((r) => r.meta);
  }

  /** Exact cosine (rows + query are L2-normalised) → top k. */
  search(query: Float32Array, k: number, filter?: (c: ChunkMeta) => boolean): { chunk: ChunkMeta; score: number }[] {
    if (query.length !== this.dim) return [];
    const out: { chunk: ChunkMeta; score: number }[] = [];
    for (const r of this.rows.values()) {
      if (filter && !filter(r.meta)) continue;
      let s = 0;
      const q = r.q;
      for (let i = 0; i < q.length; i += 1) s += q[i]! * query[i]!;
      out.push({ chunk: r.meta, score: s * r.scale });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, k);
  }

  /** Cosine for a given set of chunk ids (hybrid re-scoring). */
  scoreIds(query: Float32Array, ids: Iterable<string>): Map<string, number> {
    const m = new Map<string, number>();
    if (query.length !== this.dim) return m;
    for (const id of ids) {
      const r = this.rows.get(id);
      if (!r) continue;
      let s = 0;
      for (let i = 0; i < r.q.length; i += 1) s += r.q[i]! * query[i]!;
      m.set(id, s * r.scale);
    }
    return m;
  }

  save(force = false) {
    if (!this.dirty && !force) return false;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const rows = [...this.rows.values()];
    const stride = 4 + this.dim;
    const bin = Buffer.alloc(rows.length * stride);
    rows.forEach((r, i) => {
      const off = i * stride;
      bin.writeFloatLE(r.scale, off);
      for (let k = 0; k < this.dim; k += 1) bin.writeInt8(r.q[k]!, off + 4 + k);
    });
    this.updatedAt = Date.now();
    // vectors first, then meta (meta is the commit point; a mismatch on load → clean rebuild).
    writeAtomic(path.join(this.dir, BIN), bin);
    writeAtomic(path.join(this.dir, META), JSON.stringify({ version: 1, embedder: this.embedder, dim: this.dim, updatedAt: this.updatedAt, docs: Object.fromEntries(this.docs), chunks: rows.map((r) => r.meta) }));
    this.dirty = false;
    return true;
  }

  clear() {
    this.rows.clear();
    this.docs.clear();
    this.dirty = false;
    this.version += 1;
    for (const f of [META, BIN]) fs.rmSync(path.join(this.dir, f), { force: true });
  }

  stats(): StoreStats {
    const bySource: Record<string, number> = {};
    let textBytes = 0;
    for (const r of this.rows.values()) {
      bySource[r.meta.source] = (bySource[r.meta.source] ?? 0) + 1;
      textBytes += r.meta.text.length;
    }
    return { embedder: this.embedder, dim: this.dim, docs: this.docs.size, chunks: this.rows.size, bySource, bytes: this.rows.size * (4 + this.dim) + textBytes, updatedAt: this.updatedAt };
  }
}
