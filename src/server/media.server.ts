/**
 * W2 media: image (xAI Imagine / OpenAI-compatible) and video (xAI only, when
 * configured) saved to the library. Kill switch SABLE_MEDIA=0. Keys from
 * .env or the vault. No approval to generate, but the budget meter gates it.
 */
import { ASPECTS, IMAGE_MODELS, IMAGE_RESOLUTIONS, VIDEO_SECONDS } from "@/lib/agent/types";
import { endpoints } from "@/server/chat.server";
import { takeSlot } from "@/lib/agent/harness";
import { MediaLibrary } from "@/lib/agent/media/library";
import { generateImage, providersView, refreshVideo, startVideo, type BudgetLike, type GenResult, type MediaDeps } from "@/lib/agent/media/service";
import { checkUrl, pinnedFetch } from "@/lib/agent/tools/fetch";
import { plannerBundle } from "@/server/planner.server";
import { vaultStore } from "@/server/vault.server";
import { dataDir, workspaceDir } from "@/server/paths";

const WINDOW_MS = 10 * 60 * 1000;
const KEY = Symbol.for("sable.media.v1");

function library(): MediaLibrary {
  const scope = globalThis as unknown as Record<symbol, { lib: MediaLibrary; key: string } | undefined>;
  const key = `${dataDir()}|${workspaceDir()}`;
  if (!scope[KEY] || scope[KEY]!.key !== key) scope[KEY] = { lib: new MediaLibrary(dataDir(), workspaceDir()), key };
  return scope[KEY]!.lib;
}

function budget(): BudgetLike {
  const meter = plannerBundle().budget;
  return {
    check: (extras) => meter.check(extras),
    mediaUsd: () => meter.totals("media").usd,
    record: (kind, itemId, model, usd) => {
      meter.record({ scope: "media", scopeId: `${kind}:${itemId}`, model, usd });
    },
  };
}

/** Download a provider-returned URL: public https/http only, DNS-pinned, max 3 rechecked redirects, byte cap. */
async function safeDownload(raw: string, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  const fakeIp = process.env.SABLE_FETCH_FAKE_IP === "1";
  const get = pinnedFetch(fakeIp);
  let url = await checkUrl(raw, [], undefined, fakeIp);
  for (let hop = 0; hop < 4; hop += 1) {
    const res = await get(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      await res.body?.cancel().catch(() => {});
      if (!loc || hop === 3) throw new Error("too many redirects");
      url = await checkUrl(new URL(loc, url).toString(), [], undefined, fakeIp);
      continue;
    }
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        void reader.cancel().catch(() => {});
        throw new Error("file too large");
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  }
  throw new Error("download failed");
}

export function mediaDeps(): MediaDeps {
  return {
    env: process.env,
    endpoints: endpoints(),
    vault: (name) => {
      try {
        const v = vaultStore();
        return v.enabled() && !v.killed() ? v.get(name) : null;
      } catch {
        return null;
      }
    },
    library: library(),
    budget: budget(),
    apiFetch: fetch,
    download: safeDownload,
  };
}

const oneOf = <T extends string | number>(value: unknown, allowed: readonly T[], fallback: T): T => allowed.find((item) => item === value) ?? fallback;

export function mediaOverview() {
  const deps = mediaDeps();
  return { providers: providersView(deps), items: deps.library.list().slice(0, 300) };
}

export async function createImage(
  prompt: string,
  signal: AbortSignal,
  options: { model?: unknown; aspect?: unknown; resolution?: unknown; provider?: unknown } = {},
): Promise<GenResult> {
  if (!takeSlot("image", 8, WINDOW_MS)) return { ok: false, status: 429, code: "rate", message: "Đã tạo quá nhiều ảnh trong vài phút." };
  return generateImage(
    mediaDeps(),
    prompt,
    {
      provider: typeof options.provider === "string" ? options.provider : undefined,
      model: oneOf(options.model, IMAGE_MODELS, "grok-imagine-image-2.0"),
      aspect: oneOf(options.aspect, ASPECTS, "1:1"),
      resolution: oneOf(options.resolution, IMAGE_RESOLUTIONS, "1k"),
    },
    signal,
  );
}

export async function createVideo(prompt: string, signal: AbortSignal, options: { aspect?: unknown; seconds?: unknown } = {}): Promise<GenResult> {
  if (!takeSlot("video", 4, WINDOW_MS)) return { ok: false, status: 429, code: "rate", message: "Đã tạo quá nhiều video trong vài phút." };
  return startVideo(mediaDeps(), prompt, { aspect: oneOf(options.aspect, ASPECTS, "16:9"), seconds: oneOf(options.seconds, VIDEO_SECONDS, 6) }, signal);
}

export function pollVideo(id: string, signal: AbortSignal) {
  return refreshVideo(mediaDeps(), id, signal);
}

/** Legacy chat flow polled by provider request id: map it to the library item. */
export function itemByRequestId(requestId: string) {
  return library().list().find((i) => i.requestId === requestId) ?? null;
}

export function mediaItem(id: string) {
  return MediaLibrary.validId(id) ? library().get(id) : null;
}

export function mediaFile(id: string) {
  const item = mediaItem(id);
  if (!item) return null;
  const file = library().filePath(item);
  return file ? { item, file } : null;
}

export function deleteMedia(id: string) {
  return MediaLibrary.validId(id) ? library().remove(id) : false;
}

export function fileUrl(id: string) {
  return `/api/media/file/${id}`;
}
