import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import {
  resolveVoiceEndpoint,
  voiceOn,
  transcribe,
  speak,
  fakeWavBytes,
  MAX_AUDIO_BYTES,
  MAX_TTS_CHARS,
} from "./voice.ts";

test("voice: kill switch and endpoint resolution", () => {
  assert.equal(voiceOn({ SABLE_VOICE: "0", OPENAI_API_KEY: "sk-x" }), false);
  assert.equal(resolveVoiceEndpoint({ SABLE_VOICE: "0", OPENAI_API_KEY: "sk-x" }), null);
  assert.equal(resolveVoiceEndpoint({}), null);
  const ep = resolveVoiceEndpoint({ OPENAI_API_KEY: "sk-test", OPENAI_BASE_URL: "https://api.openai.com/v1" });
  assert.ok(ep);
  assert.equal(ep!.base, "https://api.openai.com");
  assert.equal(ep!.sttModel, "whisper-1");
  const custom = resolveVoiceEndpoint({
    VOICE_API_KEY: "vk",
    VOICE_BASE_URL: "http://127.0.0.1:19999",
    VOICE_STT_MODEL: "whisper-1",
    VOICE_TTS_MODEL: "tts-1-hd",
    VOICE_TTS_VOICE: "nova",
  });
  assert.equal(custom?.base, "http://127.0.0.1:19999");
  assert.equal(custom?.voice, "nova");
  assert.equal(custom?.ttsModel, "tts-1-hd");
});

test("voice: STT/TTS against local mock server", async () => {
  const seen: { path: string; auth?: string | null; hasFile?: boolean; body?: string }[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks);
    seen.push({ path: req.url || "", auth: req.headers.authorization, body: raw.toString("utf8").slice(0, 200) });
    if (req.url === "/v1/audio/transcriptions") {
      const ctype = String(req.headers["content-type"] || "");
      seen[seen.length - 1]!.hasFile = ctype.includes("multipart") && raw.includes(Buffer.from("file"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ text: " xin chào sable " }));
      return;
    }
    if (req.url === "/v1/audio/speech") {
      res.writeHead(200, { "content-type": "audio/mpeg" });
      res.end(Buffer.from("ID3fake-mp3-bytes"));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  const endpoint = {
    base: `http://127.0.0.1:${port}`,
    key: "sk-mock",
    sttModel: "whisper-1",
    ttsModel: "tts-1",
    voice: "alloy",
  };
  try {
    const stt = await transcribe({ bytes: fakeWavBytes("hi"), mime: "audio/wav", filename: "hi.wav", endpoint });
    assert.equal(stt.ok, true);
    if (stt.ok) assert.equal(stt.text, "xin chào sable");
    assert.ok(seen.some((s) => s.path === "/v1/audio/transcriptions" && s.auth === "Bearer sk-mock"));

    const tts = await speak({ text: "Xin chào", endpoint });
    assert.equal(tts.ok, true);
    if (tts.ok) {
      assert.equal(tts.mime, "audio/mpeg");
      assert.ok(tts.bytes.byteLength > 0);
    }

    const empty = await speak({ text: "   ", endpoint });
    assert.equal(empty.ok, false);

    const huge = await transcribe({ bytes: new Uint8Array(MAX_AUDIO_BYTES + 1), endpoint });
    assert.equal(huge.ok, false);

    const long = await speak({ text: "x".repeat(MAX_TTS_CHARS + 50), endpoint });
    assert.equal(long.ok, true); // clipped, still ok
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("voice: upstream errors do not leak keys", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ error: { message: "bad sk-secretKEY1234567890abcd" } }), { status: 401 })) as typeof fetch;
  const endpoint = { base: "http://mock", key: "sk-secretKEY1234567890abcd", sttModel: "whisper-1", ttsModel: "tts-1", voice: "alloy" };
  const stt = await transcribe({ bytes: fakeWavBytes(), endpoint, fetchImpl });
  assert.equal(stt.ok, false);
  if (!stt.ok) {
    assert.ok(!stt.message.includes("sk-secret"));
    assert.match(stt.message, /\[key\]|bad/);
  }
});
