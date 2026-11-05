import { resolveVoiceEndpoint, speak, transcribe, voiceOn, MAX_AUDIO_BYTES, MAX_TTS_CHARS } from "@/lib/agent/voice";
import { takeSlot } from "@/lib/agent/harness";

const WINDOW_MS = 10 * 60 * 1000;

export function voiceStatus() {
  const endpoint = resolveVoiceEndpoint();
  return {
    enabled: voiceOn(),
    configured: Boolean(endpoint),
    sttModel: endpoint?.sttModel,
    ttsModel: endpoint?.ttsModel,
    voice: endpoint?.voice,
  };
}

export async function runStt(params: {
  bytes: Uint8Array;
  mime?: string;
  filename?: string;
  language?: string;
  signal?: AbortSignal;
}) {
  if (!takeSlot("voice-stt", 20, WINDOW_MS)) return { ok: false as const, message: "Đã nhận dạng quá nhiều trong vài phút." };
  return transcribe(params);
}

export async function runTts(params: { text: string; voice?: string; format?: "mp3" | "wav" | "opus"; signal?: AbortSignal }) {
  if (!takeSlot("voice-tts", 20, WINDOW_MS)) return { ok: false as const, message: "Đã đọc quá nhiều trong vài phút." };
  return speak(params);
}

export { MAX_AUDIO_BYTES, MAX_TTS_CHARS };
