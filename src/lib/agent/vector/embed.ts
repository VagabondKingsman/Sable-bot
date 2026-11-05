/**
 * W5 embedders. Every text is redacted by the caller before it gets here.
 * - hash: deterministic, offline, zero-RAM model: signed feature hashing of folded word
 *   unigrams, word bigrams and character trigrams (Vietnamese diacritics folded), L2-normalised.
 *   It is a lexical embedding (good at fuzzy/partial word overlap, typo-ish matches), NOT semantic.
 * - openai-compatible: POST {base}/v1/embeddings (OpenAI, or xAI when a model is available).
 * - local: @huggingface/transformers feature-extraction, only if the package is installed.
 */
import crypto from "node:crypto";

export type Embedder = { id: string; kind: "hash" | "openai" | "xai" | "local"; dim: number; embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> };

export function fold(text: string) {
  return text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d");
}
const STOP = new Set("the a an and or of to in on at for is are was be it this that with as by from va la cua cho voi cac nhung mot nay do thi ma o tai tu den khi neu de duoc co khong".split(" "));

function h32(s: string): number {
  // FNV-1a 32-bit
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
/** Light suffix stripping so "indexing/indexed/indexes" share a feature. */
export function stem(w: string) {
  if (w.length > 5) for (const suf of ["ations", "ation", "ings", "ing", "ers", "ies", "ed", "es", "ly"]) if (w.endsWith(suf)) return w.slice(0, -suf.length);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

export function hashVector(text: string, dim: number): Float32Array {
  const v = new Float32Array(dim);
  const words = fold(text).split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w)).map(stem);
  const add = (feat: string, w: number) => {
    const h = h32(feat);
    v[h % dim] += (h & 0x80000000 ? -1 : 1) * w;
  };
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i]!;
    add(`w:${w}`, 1);
    if (i + 1 < words.length) add(`b:${w}_${words[i + 1]}`, 0.5);
    const p = `^${w}$`;
    for (let j = 0; j + 3 <= p.length; j += 1) add(`c:${p.slice(j, j + 3)}`, 0.25);
  }
  let n = 0;
  for (let i = 0; i < dim; i += 1) n += v[i]! * v[i]!;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < dim; i += 1) v[i]! /= n;
  return v;
}

export function hashEmbedder(dim = 512): Embedder {
  return { id: `hash-v1-${dim}`, kind: "hash", dim, embed: async (texts) => texts.map((t) => hashVector(t, dim)) };
}

export function openaiEmbedder(opts: { base: string; key: string; model: string; kind: "openai" | "xai"; dim?: number; fetchFn?: typeof fetch }): Embedder {
  const f = opts.fetchFn ?? fetch;
  const e: Embedder = {
    id: `${opts.kind}:${opts.model}`,
    kind: opts.kind,
    dim: opts.dim ?? 0,
    async embed(texts, signal) {
      const out: Float32Array[] = [];
      for (let i = 0; i < texts.length; i += 64) {
        const r = await f(`${opts.base}/v1/embeddings`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${opts.key}` },
          body: JSON.stringify({ model: opts.model, input: texts.slice(i, i + 64) }),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
        });
        if (!r.ok) throw new Error(`embeddings HTTP ${r.status}`);
        const d = (await r.json()) as { data?: { embedding: number[]; index: number }[] };
        const rows = (d.data ?? []).sort((a, b) => a.index - b.index);
        for (const row of rows) {
          const v = Float32Array.from(row.embedding);
          let n = 0;
          for (const x of v) n += x * x;
          n = Math.sqrt(n) || 1;
          for (let k = 0; k < v.length; k += 1) v[k]! /= n;
          out.push(v);
        }
      }
      if (out.length !== texts.length) throw new Error("embeddings: row count mismatch");
      if (!e.dim && out[0]) e.dim = out[0].length;
      return out;
    },
  };
  return e;
}

export async function localEmbedder(model = "Xenova/all-MiniLM-L6-v2"): Promise<Embedder | null> {
  try {
    const spec = "@huggingface/transformers";
    const mod = (await import(/* @vite-ignore */ spec)) as { pipeline: (task: string, model: string) => Promise<(t: string[], o: object) => Promise<{ tolist(): number[][] }>> };
    const pipe = await mod.pipeline("feature-extraction", model);
    return {
      id: `local:${model}`,
      kind: "local",
      dim: 384,
      embed: async (texts) => (await pipe(texts, { pooling: "mean", normalize: true })).tolist().map((r) => Float32Array.from(r)),
    };
  } catch {
    return null;
  }
}

export const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 32);
