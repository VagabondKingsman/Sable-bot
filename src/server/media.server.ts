import {
  ASPECTS,
  IMAGE_MODELS,
  IMAGE_RESOLUTIONS,
  VIDEO_SECONDS,
  type AspectRatio,
  type ImageModel,
  type ImageResolution,
  type VideoSeconds,
} from "@/lib/agent/types";
import { endpoints } from "@/server/chat.server";
import { imagineEndpoint } from "@/lib/agent/provider";
import { takeSlot } from "@/lib/agent/harness";

const MAX_PROMPT = 4_000;
const WINDOW_MS = 10 * 60 * 1000;

export type ImageOptions = { model?: unknown; aspect?: unknown; resolution?: unknown };
export type VideoOptions = { aspect?: unknown; seconds?: unknown };

function clip(prompt: string) {
  return prompt.trim().slice(0, MAX_PROMPT);
}

function oneOf<T extends string | number>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.find((item) => item === value) ?? fallback;
}

async function fail(res: Response) {
  let message = `Không tạo được (${res.status}).`;
  try {
    const body = (await res.json()) as { error?: { message?: string } | string; message?: string };
    const nested = body.error;
    const text = typeof nested === "string" ? nested : nested?.message || body.message;
    if (text) message = /content moderation/i.test(text) ? "Nội dung này không tạo được." : text.slice(0, 240);
  } catch {
    /* keep status */
  }
  return message;
}

const NO_IMAGINE =
  "Tạo ảnh/video cần endpoint Imagine của xAI (XAI_API_KEY hoặc LLM_BASE_URL=https://api.x.ai). Provider đang gắn chỉ hỗ trợ chat.";

/** Imagine runs only on an xAI host; other OpenAI-compatible providers get a clear error. */
function imagine() {
  const list = endpoints();
  if (!list.length) return { ok: false as const, message: "Mô hình chưa sẵn sàng." };
  const endpoint = imagineEndpoint(list);
  if (!endpoint) return { ok: false as const, message: NO_IMAGINE };
  return { ok: true as const, base: endpoint.base, key: endpoint.key };
}

function headers(key: string): HeadersInit {
  return { "Content-Type": "application/json", Authorization: `Bearer ${key}` };
}

export async function createImage(prompt: string, signal: AbortSignal, options: ImageOptions = {}) {
  const target = imagine();
  if (!target.ok) return target;
  if (!takeSlot("image", 8, WINDOW_MS)) {
    return { ok: false as const, message: "Đã tạo quá nhiều ảnh trong vài phút." };
  }
  const text = clip(prompt);
  if (!text) return { ok: false as const, message: "Thiếu mô tả ảnh." };
  const model: ImageModel = oneOf(options.model, IMAGE_MODELS, "grok-imagine-image-2.0");
  const aspect: AspectRatio = oneOf(options.aspect, ASPECTS, "1:1");
  const resolution: ImageResolution = oneOf(options.resolution, IMAGE_RESOLUTIONS, "1k");
  const timeout = AbortSignal.timeout(90_000);
  const res = await fetch(`${target.base}/v1/images/generations`, {
    method: "POST",
    signal: AbortSignal.any([signal, timeout]),
    headers: headers(target.key),
    body: JSON.stringify({
      model,
      prompt: text,
      n: 1,
      resolution,
      response_format: "url",
      aspect_ratio: aspect,
    }),
  });
  if (!res.ok) return { ok: false as const, message: await fail(res) };
  const body = (await res.json()) as { data?: { url?: string }[] };
  const url = body.data?.[0]?.url;
  if (!url) return { ok: false as const, message: "Không nhận được ảnh." };
  return { ok: true as const, url };
}

export async function startVideo(prompt: string, signal: AbortSignal, options: VideoOptions = {}) {
  const target = imagine();
  if (!target.ok) return target;
  if (!takeSlot("video", 4, WINDOW_MS)) {
    return { ok: false as const, message: "Đã tạo quá nhiều video trong vài phút." };
  }
  const text = clip(prompt);
  if (!text) return { ok: false as const, message: "Thiếu mô tả video." };
  const aspect: AspectRatio = oneOf(options.aspect, ASPECTS, "16:9");
  const duration: VideoSeconds = oneOf(options.seconds, VIDEO_SECONDS, 6);
  const timeout = AbortSignal.timeout(60_000);
  const res = await fetch(`${target.base}/v1/videos/generations`, {
    method: "POST",
    signal: AbortSignal.any([signal, timeout]),
    headers: headers(target.key),
    body: JSON.stringify({
      model: "grok-imagine-video-1.5",
      prompt: text,
      duration,
      aspect_ratio: aspect,
      resolution: "720p",
    }),
  });
  if (!res.ok) return { ok: false as const, message: await fail(res) };
  const body = (await res.json()) as { request_id?: string };
  if (!body.request_id) return { ok: false as const, message: "Không nhận được mã video." };
  return { ok: true as const, requestId: body.request_id };
}

export async function readVideo(id: string, signal: AbortSignal) {
  const target = imagine();
  if (!target.ok) return target;
  if (!/^[\w-]{8,80}$/.test(id)) return { ok: false as const, message: "Mã video không hợp lệ." };
  const timeout = AbortSignal.timeout(20_000);
  const res = await fetch(`${target.base}/v1/videos/${id}`, {
    signal: AbortSignal.any([signal, timeout]),
    headers: { Authorization: `Bearer ${target.key}` },
  });
  if (!res.ok) return { ok: false as const, message: await fail(res) };
  const body = (await res.json()) as { status?: string; video?: { url?: string }; error?: { message?: string } };
  if (body.status === "done" && body.video?.url) return { ok: true as const, status: "done" as const, url: body.video.url };
  if (body.status === "failed" || body.status === "expired") {
    const text = body.error?.message || "Video lỗi.";
    return {
      ok: true as const,
      status: "failed" as const,
      message: /content moderation/i.test(text) ? "Nội dung này không tạo được." : text.slice(0, 240),
    };
  }
  return { ok: true as const, status: "pending" as const };
}
