/**
 * Media generation flow, I/O injected so it is unit-testable without a network:
 * kill switch → provider configured? → budget (global + SABLE_MEDIA_MAX_USD) →
 * provider call → bytes saved to the library → cost recorded. Generation needs
 * no approval (D-default) but never runs past the budget.
 */
import { MediaLibrary } from "./library.ts";
import { costFor, imageProviders, imagesUrl, mediaCap, mediaEnabled, videoProviders, type EndpointLike, type SecretLookup } from "./providers.ts";
import type { ImageProvider, MediaItem, VideoProvider } from "./types.ts";

export type BudgetLike = {
  check(extras?: { addUsd?: number }): { ok: true } | { ok: false; error: string };
  mediaUsd(): number;
  record(kind: "image" | "video", itemId: string, model: string, usd: number): void;
};

export type MediaDeps = {
  env: NodeJS.ProcessEnv;
  endpoints: EndpointLike[];
  vault?: SecretLookup;
  library: MediaLibrary;
  budget: BudgetLike;
  /** Provider API calls (owner-configured hosts). */
  apiFetch: typeof fetch;
  /** Downloads of provider-returned URLs: must be SSRF-guarded. */
  download: (url: string, maxBytes: number, signal: AbortSignal) => Promise<Uint8Array>;
};

export type GenResult = { ok: true; item: MediaItem } | { ok: false; status: number; message: string; code: string };

const MAX_PROMPT = 4_000;

function refuse(status: number, code: string, message: string): GenResult {
  return { ok: false, status, code, message };
}

export function providersView(deps: Pick<MediaDeps, "env" | "endpoints" | "vault" | "budget">) {
  return {
    enabled: mediaEnabled(deps.env),
    image: imageProviders(deps.env, deps.endpoints, deps.vault).info,
    video: videoProviders(deps.env, deps.endpoints).info,
    budget: { mediaUsd: deps.budget.mediaUsd(), capUsd: mediaCap(deps.env) },
  };
}

function budgetGate(deps: MediaDeps, usd: number): GenResult | null {
  const cap = mediaCap(deps.env);
  if (cap != null && deps.budget.mediaUsd() + usd > cap) {
    return refuse(402, "budget", `Vượt ngân sách media (SABLE_MEDIA_MAX_USD=${cap}).`);
  }
  const global = deps.budget.check({ addUsd: usd });
  if (!global.ok) return refuse(402, "budget", `Vượt ngân sách: ${global.error}`);
  return null;
}

async function errorText(res: Response) {
  try {
    const body = (await res.json()) as { error?: { message?: string } | string; message?: string };
    const nested = body.error;
    const text = typeof nested === "string" ? nested : nested?.message || body.message;
    if (text) return /content moderation/i.test(text) ? "Nội dung này không tạo được." : text.slice(0, 240);
  } catch {
    /* ignore */
  }
  return `Provider lỗi (${res.status}).`;
}

export type ImageOpts = { provider?: string; model?: string; aspect?: string; resolution?: string; size?: string };

export async function generateImage(deps: MediaDeps, prompt: string, opts: ImageOpts, signal: AbortSignal): Promise<GenResult> {
  if (!mediaEnabled(deps.env)) return refuse(403, "disabled", "Media đang tắt (SABLE_MEDIA=0).");
  const text = prompt.trim().slice(0, MAX_PROMPT);
  if (!text) return refuse(400, "prompt", "Thiếu mô tả ảnh.");
  const { usable, info } = imageProviders(deps.env, deps.endpoints, deps.vault);
  const provider: ImageProvider | undefined = opts.provider ? usable.find((p) => p.id === opts.provider) : usable[0];
  if (!provider) {
    const why = info.filter((i) => !opts.provider || i.id === opts.provider).map((i) => `${i.label}: ${i.reason ?? "?"}`).join("; ");
    return refuse(409, "not_configured", `Chưa cấu hình provider ảnh. ${why}`);
  }
  const usd = costFor("image", deps.env);
  const over = budgetGate(deps, usd);
  if (over) return over;
  const model = provider.style === "xai" && opts.model ? opts.model : provider.model;
  const body: Record<string, unknown> =
    provider.style === "xai"
      ? { model, prompt: text, n: 1, response_format: "b64_json", aspect_ratio: opts.aspect ?? "1:1", resolution: opts.resolution ?? "1k" }
      : { model, prompt: text, n: 1, size: opts.size ?? "1024x1024" };
  const res = await deps.apiFetch(imagesUrl(provider.base), {
    method: "POST",
    signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${provider.key}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) return refuse(502, "provider", await errorText(res));
  const json = (await res.json()) as { data?: { b64_json?: string; url?: string }[] };
  const first = json.data?.[0];
  let bytes: Uint8Array;
  try {
    if (first?.b64_json) bytes = Buffer.from(first.b64_json, "base64");
    else if (first?.url) bytes = await deps.download(first.url, 20 * 1024 * 1024, signal);
    else return refuse(502, "provider", "Provider không trả về ảnh.");
  } catch (error) {
    return refuse(502, "download", `Không tải được ảnh: ${error instanceof Error ? error.message : "lỗi"}`);
  }
  const now = Date.now();
  const base: MediaItem = { id: MediaLibrary.newId(), kind: "image", status: "pending", prompt: text, provider: provider.id, model, createdAt: now, updatedAt: now, usd };
  let item: MediaItem;
  try {
    item = deps.library.writeFile(base, bytes);
  } catch (error) {
    return refuse(502, "bytes", error instanceof Error ? error.message : "ảnh lỗi");
  }
  deps.budget.record("image", item.id, model, usd);
  deps.library.put(item);
  return { ok: true, item };
}

export type VideoOpts = { aspect?: string; seconds?: number };

export async function startVideo(deps: MediaDeps, prompt: string, opts: VideoOpts, signal: AbortSignal): Promise<GenResult> {
  if (!mediaEnabled(deps.env)) return refuse(403, "disabled", "Media đang tắt (SABLE_MEDIA=0).");
  const text = prompt.trim().slice(0, MAX_PROMPT);
  if (!text) return refuse(400, "prompt", "Thiếu mô tả video.");
  const { usable, info } = videoProviders(deps.env, deps.endpoints);
  const provider: VideoProvider | undefined = usable[0];
  if (!provider) return refuse(409, "not_configured", `Chưa cấu hình provider video thật. ${info.map((i) => i.reason).join("; ")}`);
  const usd = costFor("video", deps.env);
  const over = budgetGate(deps, usd);
  if (over) return over;
  const res = await deps.apiFetch(`${provider.base}/v1/videos/generations`, {
    method: "POST",
    signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${provider.key}` },
    body: JSON.stringify({ model: provider.model, prompt: text, duration: opts.seconds ?? 6, aspect_ratio: opts.aspect ?? "16:9", resolution: "720p" }),
  });
  if (!res.ok) return refuse(502, "provider", await errorText(res));
  const json = (await res.json()) as { request_id?: string };
  if (!json.request_id || !/^[\w-]{8,80}$/.test(json.request_id)) return refuse(502, "provider", "Không nhận được mã video.");
  const now = Date.now();
  const item: MediaItem = {
    id: MediaLibrary.newId(),
    kind: "video",
    status: "pending",
    prompt: text,
    provider: provider.id,
    model: provider.model,
    createdAt: now,
    updatedAt: now,
    usd,
    requestId: json.request_id,
  };
  // Charged on start: the provider bills the request even when we never fetch the result.
  deps.budget.record("video", item.id, provider.model, usd);
  deps.library.put(item);
  return { ok: true, item };
}

/** Poll a pending video; on done, download (SSRF-guarded) into the library. */
export async function refreshVideo(deps: MediaDeps, id: string, signal: AbortSignal): Promise<GenResult> {
  const item = deps.library.get(id);
  if (!item || item.kind !== "video") return refuse(404, "missing", "Không thấy video.");
  if (item.status !== "pending" || !item.requestId) return { ok: true, item };
  const { usable } = videoProviders(deps.env, deps.endpoints);
  const provider = usable.find((p) => p.id === item.provider);
  if (!provider) return refuse(409, "not_configured", "Provider video không còn được cấu hình.");
  const res = await deps.apiFetch(`${provider.base}/v1/videos/${item.requestId}`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    headers: { Authorization: `Bearer ${provider.key}` },
  });
  if (!res.ok) return refuse(502, "provider", await errorText(res));
  const json = (await res.json()) as { status?: string; video?: { url?: string }; error?: { message?: string } };
  if (json.status === "done" && json.video?.url) {
    try {
      const bytes = await deps.download(json.video.url, 120 * 1024 * 1024, signal);
      return { ok: true, item: deps.library.put(deps.library.writeFile(item, bytes)) };
    } catch {
      return { ok: true, item: deps.library.put({ ...item, status: "ready", remoteUrl: json.video.url, updatedAt: Date.now() }) };
    }
  }
  if (json.status === "failed" || json.status === "expired") {
    const msg = json.error?.message || "Video lỗi.";
    return { ok: true, item: deps.library.put({ ...item, status: "failed", error: /content moderation/i.test(msg) ? "Nội dung này không tạo được." : msg.slice(0, 240), updatedAt: Date.now() }) };
  }
  return { ok: true, item };
}
