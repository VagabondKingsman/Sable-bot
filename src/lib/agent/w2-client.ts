/** Browser clients for W2 APIs: traces, media library, canvas pages. */
import { readError, withPrefix } from "@/lib/agent/client";
import type { Trace, TraceSummary } from "@/lib/agent/trace/types";

async function getJson<T>(path: string, fallback: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(withPrefix(path), { signal, cache: "no-store" });
  if (!res.ok) throw new Error(await readError(res, fallback));
  return (await res.json()) as T;
}

async function postJson<T>(path: string, body: unknown, fallback: string): Promise<T> {
  const res = await fetch(withPrefix(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await readError(res, fallback));
  return (await res.json()) as T;
}

export type TraceList = {
  enabled: boolean;
  retainDays?: number;
  total: number;
  tools: { name: string; count: number }[];
  items: TraceSummary[];
  message?: string;
};

export const tracesApi = {
  list(params: { source?: string; tool?: string; q?: string }, signal?: AbortSignal) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
    return getJson<TraceList>(`/api/traces?${qs.toString()}`, "Không tải được trace.", signal);
  },
  get(id: string, tool?: string, signal?: AbortSignal) {
    const qs = tool ? `?tool=${encodeURIComponent(tool)}` : "";
    return getJson<{ trace: Trace }>(`/api/traces/${encodeURIComponent(id)}${qs}`, "Không tải được trace.", signal);
  },
  exportUrl(id: string) {
    return withPrefix(`/api/traces/${encodeURIComponent(id)}?export=1`);
  },
};

export type MediaItem = {
  id: string;
  kind: "image" | "video";
  status: "ready" | "pending" | "failed";
  prompt: string;
  provider: string;
  model: string;
  createdAt: number;
  updatedAt: number;
  usd: number;
  mime?: string;
  bytes?: number;
  file?: string;
  remoteUrl?: string;
  error?: string;
};

export type MediaProviders = {
  enabled: boolean;
  image: { id: string; label: string; model: string; configured: boolean; reason?: string }[];
  video: { id: string; label: string; model: string; configured: boolean; reason?: string }[];
  budget: { mediaUsd: number; capUsd: number | null };
};

export const mediaApi = {
  library(signal?: AbortSignal) {
    return getJson<{ providers: MediaProviders; items: MediaItem[] }>("/api/media?list=1", "Không tải được thư viện.", signal);
  },
  generate(body: { kind: "image" | "video"; prompt: string; provider?: string; save: true }) {
    return postJson<{ item: MediaItem }>("/api/media", body, "Không tạo được.");
  },
  refresh(id: string) {
    return postJson<{ item: MediaItem }>("/api/media", { action: "refresh", id }, "Không cập nhật được.");
  },
  remove(id: string) {
    return postJson<{ ok: true }>("/api/media", { action: "delete", id }, "Không xóa được.");
  },
  fileUrl(id: string) {
    return withPrefix(`/api/media/file/${encodeURIComponent(id)}`);
  },
};

export type CanvasSummary = { id: string; title: string; version: number; createdAt: number; updatedAt: number; bytes: number };
export type CanvasDetail = CanvasSummary & { versions: { version: number; at: number; bytes: number; note?: string }[]; html: string; shownVersion: number };

export type CanvasShareView = { id: string; canvasId: string; version: number | null; createdAt: number; expiresAt: number; revokedAt?: number; views: number; lastViewAt?: number; state: "active" | "expired" | "revoked" };

export const canvasApi = {
  list(signal?: AbortSignal) {
    return getJson<{ enabled: boolean; items: CanvasSummary[] }>("/api/canvas", "Không tải được canvas.", signal);
  },
  get(id: string, version?: number, signal?: AbortSignal) {
    const qs = version ? `?v=${version}` : "";
    return getJson<{ canvas: CanvasDetail }>(`/api/canvas/${encodeURIComponent(id)}${qs}`, "Không tải được canvas.", signal);
  },
  create(title: string, html: string) {
    return postJson<{ canvas: CanvasSummary }>("/api/canvas", { action: "create", title, html }, "Không tạo được canvas.");
  },
  remove(id: string) {
    return postJson<{ ok: true }>("/api/canvas", { action: "delete", id }, "Không xóa được canvas.");
  },
  shares(id: string, signal?: AbortSignal) {
    return getJson<{ enabled: boolean; items: CanvasShareView[] }>(`/api/canvas/shares?canvas=${encodeURIComponent(id)}`, "Không tải được link chia sẻ.", signal);
  },
  share(canvasId: string, ttlHours: number, version?: number) {
    return postJson<{ share: CanvasShareView; url: string }>("/api/canvas/shares", { action: "create", canvasId, ttlHours, ...(version ? { version } : {}) }, "Không tạo được link chia sẻ.");
  },
  revokeShare(id: string) {
    return postJson<{ share: CanvasShareView }>("/api/canvas/shares", { action: "revoke", id }, "Không thu hồi được link.");
  },
  viewUrl(id: string, version?: number) {
    const qs = version ? `?v=${version}` : "";
    return withPrefix(`/api/canvas/${encodeURIComponent(id)}/view${qs}`);
  },
};
