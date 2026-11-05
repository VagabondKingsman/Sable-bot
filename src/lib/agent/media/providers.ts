/**
 * Which real media APIs are configured. Nothing here fakes a provider: when no
 * key/base is set the provider is reported `configured: false` with a reason
 * and generation is refused.
 *
 * Image: xAI Imagine (any xAI endpoint Sable already uses) and a generic
 *   OpenAI-compatible `/v1/images/generations` endpoint
 *   (SABLE_IMAGE_BASE_URL + SABLE_IMAGE_API_KEY, key may live in the vault).
 * Video: xAI Imagine video only (there is no common OpenAI-compatible video API).
 */
import type { ImageProvider, ProviderInfo, VideoProvider } from "./types.ts";

export type EndpointLike = { base: string; key: string; xai?: boolean };
export type SecretLookup = (name: string) => string | null;

export const DEFAULT_XAI_IMAGE_MODEL = "grok-imagine-image-2.0";
export const DEFAULT_XAI_VIDEO_MODEL = "grok-imagine-video-1.5";

export function mediaEnabled(env: NodeJS.ProcessEnv = process.env) {
  return (env.SABLE_MEDIA ?? "1").trim() !== "0";
}

function secret(env: NodeJS.ProcessEnv, name: string, vault?: SecretLookup) {
  const fromEnv = env[name]?.trim();
  if (fromEnv) return fromEnv;
  try {
    return vault?.(name)?.trim() || "";
  } catch {
    return "";
  }
}

/** https only, except loopback when SABLE_IMAGE_ALLOW_LOCAL=1 (e.g. a local SD server). Owner-set env, not model input. */
export function checkBase(raw: string, env: NodeJS.ProcessEnv = process.env): { ok: true; base: string } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "SABLE_IMAGE_BASE_URL không hợp lệ" };
  }
  if (url.username || url.password) return { ok: false, reason: "base URL không được chứa thông tin đăng nhập" };
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol === "http:" && !(local && env.SABLE_IMAGE_ALLOW_LOCAL === "1")) return { ok: false, reason: "base URL phải là https" };
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, reason: "base URL phải là https" };
  if (local && env.SABLE_IMAGE_ALLOW_LOCAL !== "1") return { ok: false, reason: "loopback cần SABLE_IMAGE_ALLOW_LOCAL=1" };
  return { ok: true, base: url.toString().replace(/\/+$/, "") };
}

export function imageProviders(env: NodeJS.ProcessEnv, endpoints: EndpointLike[], vault?: SecretLookup): { usable: ImageProvider[]; info: ProviderInfo[] } {
  const usable: ImageProvider[] = [];
  const info: ProviderInfo[] = [];
  const xai = endpoints.find((e) => e.xai);
  const xaiModel = env.SABLE_IMAGE_MODEL_XAI?.trim() || DEFAULT_XAI_IMAGE_MODEL;
  if (xai) {
    usable.push({ id: "xai", label: "xAI Imagine", base: xai.base.replace(/\/+$/, ""), key: xai.key, model: xaiModel, style: "xai" });
    info.push({ id: "xai", label: "xAI Imagine", model: xaiModel, configured: true });
  } else {
    info.push({ id: "xai", label: "xAI Imagine", model: xaiModel, configured: false, reason: "chưa có XAI_API_KEY / endpoint xAI" });
  }
  const baseRaw = env.SABLE_IMAGE_BASE_URL?.trim() || "";
  const key = secret(env, "SABLE_IMAGE_API_KEY", vault);
  const model = env.SABLE_IMAGE_MODEL?.trim() || "gpt-image-1";
  if (!baseRaw) {
    info.push({ id: "openai-compat", label: "OpenAI-compatible", model, configured: false, reason: "chưa đặt SABLE_IMAGE_BASE_URL" });
  } else {
    const checked = checkBase(baseRaw, env);
    if (!checked.ok) info.push({ id: "openai-compat", label: "OpenAI-compatible", model, configured: false, reason: checked.reason });
    else if (!key) info.push({ id: "openai-compat", label: "OpenAI-compatible", model, configured: false, reason: "chưa có SABLE_IMAGE_API_KEY (env hoặc vault)" });
    else {
      usable.push({ id: "openai-compat", label: "OpenAI-compatible", base: checked.base, key, model, style: "openai" });
      info.push({ id: "openai-compat", label: "OpenAI-compatible", model, configured: true });
    }
  }
  return { usable, info };
}

export function videoProviders(env: NodeJS.ProcessEnv, endpoints: EndpointLike[]): { usable: VideoProvider[]; info: ProviderInfo[] } {
  const model = env.SABLE_VIDEO_MODEL_XAI?.trim() || DEFAULT_XAI_VIDEO_MODEL;
  if (env.SABLE_VIDEO === "0") {
    return { usable: [], info: [{ id: "xai", label: "xAI Imagine video", model, configured: false, reason: "SABLE_VIDEO=0" }] };
  }
  const xai = endpoints.find((e) => e.xai);
  if (!xai) {
    return { usable: [], info: [{ id: "xai", label: "xAI Imagine video", model, configured: false, reason: "chưa cấu hình provider video thật (cần XAI_API_KEY)" }] };
  }
  return {
    usable: [{ id: "xai", label: "xAI Imagine video", base: xai.base.replace(/\/+$/, ""), key: xai.key, model }],
    info: [{ id: "xai", label: "xAI Imagine video", model, configured: true }],
  };
}

/** `<base>/v1/images/generations`, tolerating a base that already ends with /v1. */
export function imagesUrl(base: string) {
  return /\/v1$/.test(base) ? `${base}/images/generations` : `${base}/v1/images/generations`;
}

export function costFor(kind: "image" | "video", env: NodeJS.ProcessEnv = process.env) {
  const raw = Number(kind === "image" ? env.SABLE_MEDIA_IMAGE_USD : env.SABLE_MEDIA_VIDEO_USD);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return kind === "image" ? 0.07 : 0.5;
}

export function mediaCap(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = Number(env.SABLE_MEDIA_MAX_USD);
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}
