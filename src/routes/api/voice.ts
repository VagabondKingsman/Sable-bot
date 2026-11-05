import { createFileRoute } from "@tanstack/react-router";
import { guarded, methodNotAllowed, readJsonBody } from "@/server/http";
import { MAX_AUDIO_BYTES, MAX_TTS_CHARS, runStt, runTts, voiceStatus } from "@/server/voice.server";

/**
 * Voice STT/TTS.
 * GET  → status (no secrets)
 * POST { kind: "stt", audioBase64, mime?, filename?, language? }
 * POST { kind: "tts", text, voice?, format? } → { mime, audioBase64 }
 */
export const Route = createFileRoute("/api/voice")({
  server: {
    handlers: {
      GET: () => guarded("GET /api/voice", () => Response.json(voiceStatus(), { headers: { "cache-control": "no-store" } })),
      POST: ({ request }) =>
        guarded("POST /api/voice", async () => {
          // Base64 audio inflates ~4/3; allow a bit over MAX_AUDIO_BYTES encoded.
          const read = await readJsonBody(request, Math.ceil(MAX_AUDIO_BYTES * 1.5) + 8_000);
          if (!read.ok) return Response.json({ message: read.message }, { status: read.status });
          if (!read.value || typeof read.value !== "object" || Array.isArray(read.value))
            return Response.json({ message: "Không đọc được yêu cầu." }, { status: 400 });
          const body = read.value as {
            kind?: string;
            audioBase64?: string;
            mime?: string;
            filename?: string;
            language?: string;
            text?: string;
            voice?: string;
            format?: string;
          };
          if (body.kind === "stt") {
            if (typeof body.audioBase64 !== "string" || !body.audioBase64) {
              return Response.json({ message: "Thiếu audioBase64." }, { status: 400 });
            }
            let bytes: Uint8Array;
            try {
              bytes = Uint8Array.from(Buffer.from(body.audioBase64, "base64"));
            } catch {
              return Response.json({ message: "audioBase64 không hợp lệ." }, { status: 400 });
            }
            if (bytes.byteLength > MAX_AUDIO_BYTES) {
              return Response.json({ message: `Audio quá lớn (tối đa ${MAX_AUDIO_BYTES} B).` }, { status: 413 });
            }
            const result = await runStt({
              bytes,
              mime: typeof body.mime === "string" ? body.mime.slice(0, 80) : undefined,
              filename: typeof body.filename === "string" ? body.filename.slice(0, 80) : undefined,
              language: typeof body.language === "string" ? body.language : undefined,
              signal: request.signal,
            });
            return result.ok
              ? Response.json({ text: result.text })
              : Response.json({ message: result.message }, { status: 502 });
          }
          if (body.kind === "tts") {
            if (typeof body.text !== "string") return Response.json({ message: "Thiếu text." }, { status: 400 });
            const text = body.text.trim().slice(0, MAX_TTS_CHARS);
            if (!text) return Response.json({ message: "Thiếu chữ để đọc." }, { status: 400 });
            const format = body.format === "wav" || body.format === "opus" ? body.format : "mp3";
            const result = await runTts({
              text,
              voice: typeof body.voice === "string" ? body.voice : undefined,
              format,
              signal: request.signal,
            });
            if (!result.ok) return Response.json({ message: result.message }, { status: 502 });
            return Response.json({
              mime: result.mime,
              audioBase64: Buffer.from(result.bytes).toString("base64"),
            });
          }
          return Response.json({ message: "Loại không hợp lệ (stt|tts)." }, { status: 400 });
        }),
      ANY: methodNotAllowed("GET, POST"),
    },
  },
});
