import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MediaLibrary, sniffMime } from "./library.ts";
import { checkBase, imageProviders, imagesUrl, videoProviders } from "./providers.ts";
import { generateImage, providersView, refreshVideo, startVideo, type BudgetLike, type MediaDeps } from "./service.ts";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c50000000049454e44ae426082", "hex");
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypmp42"), Buffer.alloc(16)]);

function memBudget(capUsd?: number): BudgetLike & { spent: number; events: string[] } {
  const b = {
    spent: 0,
    events: [] as string[],
    check(extras?: { addUsd?: number }) {
      if (capUsd != null && b.spent + (extras?.addUsd ?? 0) > capUsd) return { ok: false as const, error: "global cap" };
      return { ok: true as const };
    },
    mediaUsd: () => b.spent,
    record(kind: string, id: string, _m: string, usd: number) {
      b.spent += usd;
      b.events.push(`${kind}:${id}`);
    },
  };
  return b;
}

function deps(over: Partial<MediaDeps> = {}): MediaDeps & { calls: string[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sable-media-"));
  const calls: string[] = [];
  const apiFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${String(url)}`);
    if (String(url).endsWith("/images/generations")) return Response.json({ data: [{ b64_json: PNG.toString("base64") }] });
    if (String(url).endsWith("/videos/generations")) return Response.json({ request_id: "req_12345678" });
    if (String(url).includes("/videos/req_12345678")) return Response.json({ status: "done", video: { url: "https://cdn.example.com/v.mp4" } });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  const d = {
    env: {},
    endpoints: [{ base: "https://api.x.ai", key: "k", xai: true }],
    library: new MediaLibrary(path.join(dir, "data"), path.join(dir, "ws")),
    budget: memBudget(),
    apiFetch,
    download: async () => MP4,
    calls,
    ...over,
  };
  return d as MediaDeps & { calls: string[] };
}

const sig = () => new AbortController().signal;

test("media: providers report not-configured honestly (no fake video)", () => {
  const none = imageProviders({}, []);
  assert.equal(none.usable.length, 0);
  assert.ok(none.info.every((i) => !i.configured && i.reason));
  const vid = videoProviders({}, []);
  assert.equal(vid.usable.length, 0);
  assert.match(vid.info[0]!.reason!, /chưa cấu hình/);
  assert.equal(videoProviders({ SABLE_VIDEO: "0" }, [{ base: "https://api.x.ai", key: "k", xai: true }]).usable.length, 0);
  const generic = imageProviders({ SABLE_IMAGE_BASE_URL: "https://img.example.com/v1" }, [], (n) => (n === "SABLE_IMAGE_API_KEY" ? "vault-key" : null));
  assert.equal(generic.usable[0]?.id, "openai-compat", "key from vault");
  assert.equal(imagesUrl("https://img.example.com/v1"), "https://img.example.com/v1/images/generations");
  assert.equal(checkBase("http://evil.example.com").ok, false);
  assert.equal(checkBase("http://127.0.0.1:7860").ok, false);
  assert.equal(checkBase("http://127.0.0.1:7860", { SABLE_IMAGE_ALLOW_LOCAL: "1" }).ok, true);
});

test("media: image not-configured path → 409, no provider call", async () => {
  const d = deps({ endpoints: [] });
  const res = await generateImage(d, "a cat", {}, sig());
  assert.equal(res.ok, false);
  assert.equal(!res.ok && res.code, "not_configured");
  assert.equal(!res.ok && res.status, 409);
  assert.equal(d.calls.length, 0);
  const view = providersView(d);
  assert.equal(view.image.some((p) => p.configured), false);
  const v = await startVideo(d, "a cat", {}, sig());
  assert.equal(!v.ok && v.code, "not_configured");
});

test("media: image saved to library, bytes sniffed, cost recorded", async () => {
  const d = deps();
  const res = await generateImage(d, "a red dot", {}, sig());
  assert.ok(res.ok);
  if (!res.ok) return;
  assert.equal(res.item.mime, "image/png");
  assert.equal(res.item.status, "ready");
  assert.match(res.item.file!, /^media\/m_[a-z0-9]+\.png$/);
  const file = d.library.filePath(res.item)!;
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(d.library.list().length, 1);
  assert.equal((d.budget as ReturnType<typeof memBudget>).events.length, 1);
  assert.ok(d.calls[0]!.startsWith("POST https://api.x.ai/v1/images/generations"));
  assert.equal(sniffMime(Buffer.from("<html>")), null);
});

test("media: budget trip refuses before calling the provider", async () => {
  const d = deps({ env: { SABLE_MEDIA_MAX_USD: "0.1", SABLE_MEDIA_IMAGE_USD: "0.07" } });
  assert.ok((await generateImage(d, "one", {}, sig())).ok);
  const before = d.calls.length;
  const second = await generateImage(d, "two", {}, sig());
  assert.equal(second.ok, false);
  assert.equal(!second.ok && second.code, "budget");
  assert.equal(!second.ok && second.status, 402);
  assert.equal(d.calls.length, before, "no provider call after budget trip");
  const g = deps({ budget: memBudget(0.01) });
  const tripped = await generateImage(g, "x", {}, sig());
  assert.equal(!tripped.ok && tripped.code, "budget", "global budget cap also applies");
});

test("media: kill switch SABLE_MEDIA=0", async () => {
  const d = deps({ env: { SABLE_MEDIA: "0" } });
  const res = await generateImage(d, "x", {}, sig());
  assert.equal(!res.ok && res.code, "disabled");
  assert.equal(d.calls.length, 0);
});

test("media: video start → pending → refresh downloads into library", async () => {
  const d = deps();
  const started = await startVideo(d, "waves", {}, sig());
  assert.ok(started.ok);
  if (!started.ok) return;
  assert.equal(started.item.status, "pending");
  const done = await refreshVideo(d, started.item.id, sig());
  assert.ok(done.ok);
  if (!done.ok) return;
  assert.equal(done.item.status, "ready");
  assert.equal(done.item.mime, "video/mp4");
  assert.ok(d.library.remove(done.item.id));
  assert.equal(d.library.list().length, 0);
});

test("media: non-image bytes from provider rejected", async () => {
  const d = deps({
    apiFetch: (async () => Response.json({ data: [{ b64_json: Buffer.from("<script>alert(1)</script>").toString("base64") }] })) as typeof fetch,
  });
  const res = await generateImage(d, "x", {}, sig());
  assert.equal(!res.ok && res.code, "bytes");
});
