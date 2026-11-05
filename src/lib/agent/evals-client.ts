/** Browser client for W5 recall search, vector index status and self-eval APIs. */
import { readError, withPrefix } from "@/lib/agent/client";
import type { EvalSettings, GradeRow, RegressRun, ReviewItem, ReviewState } from "@/lib/agent/evals/store";

export type RecallHit = { id: string; source: string; title: string; ref: string; at: number; text: string; score: number; parts: { bm25: number; vector: number; recency: number } };
export type RecallResult = { enabled: boolean; embedder?: string | null; mode?: string; ms?: number; hits: RecallHit[] };
export type VectorStatus = {
  enabled: boolean;
  embedder: string | null;
  embedderKind: string | null;
  tried: { provider: string; ok: boolean; why: string }[];
  provider: string;
  stats: { embedder: string; dim: number; docs: number; chunks: number; bySource: Record<string, number>; bytes: number; updatedAt: number } | null;
  last: { added: number; updated: number; removed: number; unchanged: number; chunks: number; redactions: number; ms: number } | null;
  lastAt: number | null;
  lastError: string | null;
  syncing: boolean;
  maxChunks: number;
  syncMin: number;
  recallTokens: number;
};
export type EvalsView = {
  enabled: boolean;
  grader: string;
  summary: { runs: number; failed: number; avgSuccess: number; avgGrounded: number };
  grades: GradeRow[];
  reviews: ReviewItem[];
  settings: EvalSettings;
  routineId: string;
  regress: RegressRun[];
  running: { since: number; suite: string } | null;
};

async function get<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(withPrefix(url), { signal, cache: "no-store" });
  if (!res.ok) throw new Error(await readError(res, "Không tải được."));
  return (await res.json()) as T;
}
async function post<T>(url: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(withPrefix(url), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await readError(res, "Thao tác thất bại."));
  return (await res.json()) as T;
}

export const recallApi = {
  search: (q: string, opts: { sources?: string[]; mode?: string; k?: number } = {}, signal?: AbortSignal) => {
    const u = new URLSearchParams({ q });
    if (opts.sources?.length) u.set("sources", opts.sources.join(","));
    if (opts.mode) u.set("mode", opts.mode);
    if (opts.k) u.set("k", String(opts.k));
    return get<RecallResult>(`/api/recall?${u}`, signal);
  },
  status: (signal?: AbortSignal) => get<VectorStatus>("/api/vector", signal),
  sync: (rebuild = false) => post<{ status: VectorStatus }>("/api/vector", { action: rebuild ? "rebuild" : "sync" }),
};

export const evalsApi = {
  view: (signal?: AbortSignal) => get<EvalsView>("/api/evals", signal),
  review: (id: string, state: ReviewState) => post<{ ok: boolean }>("/api/evals", { action: "review", id, state }),
  settings: (patch: Partial<Pick<EvalSettings, "nightly" | "time" | "suites">>) => post<{ settings: EvalSettings }>("/api/evals", { action: "settings", ...patch }),
  run: (suites?: string[]) => post<{ started: boolean }>("/api/evals", { action: "run", suites }),
};
