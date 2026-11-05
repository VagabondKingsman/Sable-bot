/**
 * W5 (D4) local vector store config. Kill switch SABLE_VECTOR=0.
 * Embeddings: SABLE_EMBED_PROVIDER = auto | openai | xai | local | hash
 *   auto → OpenAI (OPENAI_API_KEY) → xAI (only when SABLE_EMBED_MODEL names a model the key can use)
 *        → local small model (only if @huggingface/transformers is installed) → deterministic hash.
 */
import path from "node:path";

export type EmbedProvider = "auto" | "openai" | "xai" | "local" | "hash";
export type VectorConfig = {
  enabled: boolean;
  dir: string;
  provider: EmbedProvider;
  model: string;
  hashDim: number;
  maxChunks: number;
  chunkChars: number;
  syncMin: number;
  recallTokens: number;
  workspaceRoot: string;
};

const num = (raw: string | undefined, def: number, min: number, max: number) => {
  const n = Number(raw);
  return raw === undefined || raw === "" || !Number.isFinite(n) ? def : Math.min(max, Math.max(min, n));
};

export function vectorConfig(env: Record<string, string | undefined> = process.env): VectorConfig {
  const data = path.resolve(env.SABLE_DATA_DIR?.trim() || "/workspace/sable-data");
  const p = (env.SABLE_EMBED_PROVIDER ?? "auto").trim().toLowerCase();
  return {
    enabled: env.SABLE_VECTOR !== "0",
    dir: path.join(data, "vector"),
    provider: (["auto", "openai", "xai", "local", "hash"].includes(p) ? p : "auto") as EmbedProvider,
    model: (env.SABLE_EMBED_MODEL ?? "").trim().slice(0, 80),
    hashDim: Math.floor(num(env.SABLE_EMBED_HASH_DIM, 512, 64, 2048)),
    maxChunks: Math.floor(num(env.SABLE_VECTOR_MAX_CHUNKS, 20_000, 100, 200_000)),
    chunkChars: Math.floor(num(env.SABLE_VECTOR_CHUNK_CHARS, 800, 200, 4000)),
    syncMin: num(env.SABLE_VECTOR_SYNC_MIN, 10, 1, 1440),
    recallTokens: Math.floor(num(env.SABLE_RECALL_TOKENS, 500, 0, 4000)),
    workspaceRoot: path.resolve(env.SABLE_WORKSPACE?.trim() || "/workspace/sable-workspace"),
  };
}
