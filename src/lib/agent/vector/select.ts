/** W5: choose the embedder per config; reports which one ran and why the others did not. */
import { hashEmbedder, localEmbedder, openaiEmbedder, type Embedder } from "./embed.ts";
import type { VectorConfig } from "./config.ts";

export type Picked = { embedder: Embedder; tried: { provider: string; ok: boolean; why: string }[] };

export async function pickEmbedder(cfg: VectorConfig, env: Record<string, string | undefined>, fetchFn: typeof fetch = fetch): Promise<Picked> {
  const tried: Picked["tried"] = [];
  const want = cfg.provider;
  const probe = async (e: Embedder) => {
    const [v] = await e.embed(["sable embedding probe"]);
    if (!v?.length) throw new Error("empty vector");
    return e;
  };
  if (want === "auto" || want === "openai") {
    const key = env.OPENAI_API_KEY?.trim();
    if (!key) tried.push({ provider: "openai", ok: false, why: "OPENAI_API_KEY không có" });
    else {
      try {
        const base = (env.OPENAI_BASE_URL?.trim() || "https://api.openai.com").replace(/\/+$/, "").replace(/\/v1$/, "");
        const e = await probe(openaiEmbedder({ base, key, model: cfg.model || "text-embedding-3-small", kind: "openai", fetchFn }));
        tried.push({ provider: "openai", ok: true, why: e.id });
        return { embedder: e, tried };
      } catch (err) {
        tried.push({ provider: "openai", ok: false, why: err instanceof Error ? err.message.slice(0, 120) : "lỗi" });
      }
    }
  }
  if (want === "auto" || want === "xai") {
    const key = env.XAI_API_KEY?.trim();
    if (!key) tried.push({ provider: "xai", ok: false, why: "XAI_API_KEY không có" });
    else if (!cfg.model && want === "auto") tried.push({ provider: "xai", ok: false, why: "chưa đặt SABLE_EMBED_MODEL (xAI hiện không liệt kê model embeddings)" });
    else {
      try {
        const base = (env.XAI_BASE_URL?.trim() || "https://api.x.ai").replace(/\/+$/, "").replace(/\/v1$/, "");
        const e = await probe(openaiEmbedder({ base, key, model: cfg.model || "v1", kind: "xai", fetchFn }));
        tried.push({ provider: "xai", ok: true, why: e.id });
        return { embedder: e, tried };
      } catch (err) {
        tried.push({ provider: "xai", ok: false, why: err instanceof Error ? err.message.slice(0, 120) : "lỗi" });
      }
    }
  }
  if (want === "auto" || want === "local") {
    const e = await localEmbedder(cfg.model && want === "local" ? cfg.model : undefined);
    if (e) {
      tried.push({ provider: "local", ok: true, why: e.id });
      return { embedder: e, tried };
    }
    tried.push({ provider: "local", ok: false, why: "@huggingface/transformers chưa cài (không cài để tiết kiệm RAM)" });
  }
  const e = hashEmbedder(cfg.hashDim);
  tried.push({ provider: "hash", ok: true, why: `${e.id} (dự phòng tất định, từ vựng — không phải ngữ nghĩa)` });
  return { embedder: e, tried };
}
