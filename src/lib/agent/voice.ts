/**
 * Voice STT/TTS — OpenAI-compatible `/v1/audio/transcriptions` and `/v1/audio/speech`.
 * Fresh Sable code (design only from AIC/OpenClaw-class voice desks). Kill switch
 * SABLE_VOICE=0. Uses VOICE_* env, falling back to OPENAI_* when present.
 */
import { createHmac } from "node:crypto";

export const MAX_AUDIO_BYTES = 4 * 1024 * 1024;
export const MAX_TTS_CHARS = 4_000;
export const STT_MODELS = ["whisper-1", "gpt-4o-mini-transcribe", "gpt-4o-transcribe"] as const;
export const TTS_MODELS = ["tts-1", "tts-1-hd", "gpt-4o-mini-tts"] as const;
export const TTS_VOICES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"] as const;

export type VoiceEndpoint = { base: string; key: string; sttModel: string; ttsModel: string; voice: string };

export function voiceOn(env: Record<string, string | undefined> = process.env): boolean {
  return (env.SABLE_VOICE ?? "1").trim() !== "0";
}

export function resolveVoiceEndpoint(env: Record<string, string | undefined> = process.env): VoiceEndpoint | null {
  if (!voiceOn(env)) return null;
  const key = (env.VOICE_API_KEY || env.OPENAI_API_KEY || "").trim();
  if (!key) return null;
  const base = normalizeBase(env.VOICE_BASE_URL || env.OPENAI_BASE_URL || "https://api.openai.com");
  const sttModel = (env.VOICE_STT_MODEL || "whisper-1").trim() || "whisper-1";
  const ttsModel = (env.VOICE_TTS_MODEL || "tts-1").trim() || "tts-1";
  const voice = (env.VOICE_TTS_VOICE || "alloy").trim() || "alloy";
  return { base, key, sttModel, ttsModel, voice };
}

function normalizeBase(raw: string) {
  return raw.trim().replace(/\/+$/, "").replace(/\/v1$/i, "") || "https://api.openai.com";
}

export type TranscribeInput = {
  bytes: Uint8Array | Buffer;
  mime?: string;
  filename?: string;
  language?: string;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  endpoint?: VoiceEndpoint;
};

export type SpeakInput = {
  text: string;
  voice?: string;
  format?: "mp3" | "wav" | "opus";
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  endpoint?: VoiceEndpoint;
};

function clipName(name: string) {
  return name.replace(/[^\w.\-]+/g, "_").slice(0, 80) || "audio.webm";
}

export async function transcribe(input: TranscribeInput): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
  const endpoint = input.endpoint ?? resolveVoiceEndpoint();
  if (!endpoint) return { ok: false, message: "Giọng nói chưa cấu hình (VOICE_API_KEY / OPENAI_API_KEY)." };
  if (!input.bytes?.byteLength) return { ok: false, message: "Thiếu audio." };
  if (input.bytes.byteLength > MAX_AUDIO_BYTES) return { ok: false, message: `Audio quá lớn (tối đa ${MAX_AUDIO_BYTES} B).` };
  const form = new FormData();
  const blob = new Blob([Uint8Array.from(input.bytes)], { type: input.mime || "application/octet-stream" });
  form.append("file", blob, clipName(input.filename || "audio.webm"));
  form.append("model", endpoint.sttModel);
  if (input.language?.trim()) form.append("language", input.language.trim().slice(0, 16));
  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(`${endpoint.base}/v1/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${endpoint.key}` },
      body: form,
      signal: input.signal ?? AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const message = await voiceFail(res);
      return { ok: false, message };
    }
    const body = (await res.json()) as { text?: unknown };
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) return { ok: false, message: "Không nghe được nội dung." };
    return { ok: true, text: text.slice(0, 16_000) };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return { ok: false, message: "Hết giờ khi nhận dạng giọng." };
    return { ok: false, message: error instanceof Error ? error.message.slice(0, 200) : "Lỗi nhận dạng giọng." };
  }
}

export async function speak(input: SpeakInput): Promise<{ ok: true; bytes: Uint8Array; mime: string } | { ok: false; message: string }> {
  const endpoint = input.endpoint ?? resolveVoiceEndpoint();
  if (!endpoint) return { ok: false, message: "Giọng nói chưa cấu hình (VOICE_API_KEY / OPENAI_API_KEY)." };
  const text = input.text.trim().slice(0, MAX_TTS_CHARS);
  if (!text) return { ok: false, message: "Thiếu chữ để đọc." };
  const format = input.format === "wav" || input.format === "opus" ? input.format : "mp3";
  const voice = (input.voice || endpoint.voice).slice(0, 32);
  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(`${endpoint.base}/v1/audio/speech`, {
      method: "POST",
      headers: { Authorization: `Bearer ${endpoint.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: endpoint.ttsModel, input: text, voice, response_format: format }),
      signal: input.signal ?? AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const message = await voiceFail(res);
      return { ok: false, message };
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (!buf.byteLength) return { ok: false, message: "Không tạo được audio." };
    if (buf.byteLength > MAX_AUDIO_BYTES * 2) return { ok: false, message: "Audio trả về quá lớn." };
    const mime = format === "wav" ? "audio/wav" : format === "opus" ? "audio/opus" : "audio/mpeg";
    return { ok: true, bytes: buf, mime };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") return { ok: false, message: "Hết giờ khi tổng hợp giọng." };
    return { ok: false, message: error instanceof Error ? error.message.slice(0, 200) : "Lỗi tổng hợp giọng." };
  }
}

async function voiceFail(res: Response) {
  let message = `Giọng nói lỗi (${res.status}).`;
  try {
    const body = (await res.json()) as { error?: { message?: string } | string; message?: string };
    const nested = body.error;
    const text = typeof nested === "string" ? nested : nested?.message || body.message;
    if (text) message = text.slice(0, 240);
  } catch {
    /* keep */
  }
  // Never echo bearer tokens if upstream somehow reflected them.
  return message.replace(/sk-[A-Za-z0-9_-]+/g, "[key]");
}

/** Tiny helper for unit tests to forge a deterministic fake wav header (not a real sample). */
export function fakeWavBytes(label = "ping"): Uint8Array {
  const payload = Buffer.from(`RIFF....WAVEfmt ${label}`);
  return new Uint8Array(payload);
}

/** Stable id for client audio blobs (not crypto secret). */
export function audioTag(bytes: Uint8Array) {
  return createHmac("sha256", "sable-voice-tag").update(bytes).digest("hex").slice(0, 12);
}
