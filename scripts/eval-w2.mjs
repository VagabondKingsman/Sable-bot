/**
 * W2 eval: trace export shape, media not-configured + budget trip + kill switch,
 * canvas versions + CSP sandbox. Offline cases always run; live HTTP cases run
 * against SABLE_EVAL_URL (default http://localhost:8080) when it answers.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exportTrace, filterByTool, fromJob, isTraceExport } from "../src/lib/agent/trace/build.ts";
import { TraceArchive } from "../src/lib/agent/trace/archive.ts";
import { TRACE_SCHEMA } from "../src/lib/agent/trace/types.ts";
import { MediaLibrary } from "../src/lib/agent/media/library.ts";
import { generateImage, startVideo, providersView } from "../src/lib/agent/media/service.ts";
import { CanvasStore } from "../src/lib/agent/canvas/store.ts";
import { CANVAS_CSP, IFRAME_SANDBOX } from "../src/lib/agent/canvas/render.ts";

const results = [];
function pass(name) {
  results.push(["PASS", name]);
  console.log("PASS", name);
}
function skip(name, why) {
  results.push(["SKIP", name]);
  console.log("SKIP", name, "-", why);
}
function fail(name, err) {
  results.push(["FAIL", name]);
  console.error("FAIL", name, err?.message || err);
  process.exitCode = 1;
}
async function run(name, fn) {
  try {
    const r = await fn();
    if (r === "skip") return;
    pass(name);
  } catch (e) {
    fail(name, e);
  }
}
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sig = () => new AbortController().signal;

function job() {
  const now = 1_790_000_000_000;
  return {
    id: "evaljob1",
    title: "eval",
    kind: "agent",
    status: "done",
    request: { model: "grok-4.7" },
    maxSteps: 8,
    timeoutMs: 60000,
    createdAt: now - 5000,
    updatedAt: now,
    startedAt: now - 4000,
    finishedAt: now,
    usedMs: 4000,
    attempts: 1,
    text: "ok",
    steps: [
      { id: "tool-1-a", kind: "tool", label: "fs_read · a", tool: "fs_read", at: now - 3900, ms: 12, state: "done", detail: "ok · 12 ms" },
      { id: "tool-1-b", kind: "tool", label: "spawn_agent", tool: "spawn_agent", at: now - 3800, ms: 900, state: "done", detail: "ok · 900 ms" },
      { id: "tool-1-b~c", kind: "tool", label: "http_fetch", tool: "http_fetch", parent: "tool-1-b", state: "done", detail: "ok · 40 ms" },
      { id: "tool-2-d", kind: "tool", label: "fs_write", tool: "fs_write", at: now - 2000, state: "done", detail: "ok · 30 ms\nXAI_API_KEY=xai-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
    ],
    approvals: [{ id: "ap1", tool: "fs_write", summary: "write", state: "approved" }],
    notices: [],
    citations: [],
  };
}

function memBudget(cap) {
  const b = {
    spent: 0,
    check(x) {
      return cap != null && b.spent + (x?.addUsd ?? 0) > cap ? { ok: false, error: "global cap reached" } : { ok: true };
    },
    mediaUsd: () => b.spent,
    record(_k, _id, _m, usd) {
      b.spent += usd;
    },
  };
  return b;
}
function mediaDeps(over = {}) {
  const dir = tmp("eval-media-");
  const calls = [];
  const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c50000000049454e44ae426082", "hex");
  return {
    env: {},
    endpoints: [{ base: "https://api.x.ai", key: "k", xai: true }],
    library: new MediaLibrary(path.join(dir, "d"), path.join(dir, "w")),
    budget: memBudget(),
    apiFetch: async (url, init) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      return Response.json({ data: [{ b64_json: PNG.toString("base64") }] });
    },
    download: async () => new Uint8Array(),
    calls,
    ...over,
  };
}

// ---------- offline ----------
await run("trace-export-shape", () => {
  const t = fromJob(job());
  const doc = exportTrace(t, 1_790_000_100_000);
  assert.equal(doc.schema, TRACE_SCHEMA);
  assert.ok(isTraceExport(doc));
  assert.equal(doc.trace.id, "job.evaljob1");
  const kinds = new Set(doc.trace.events.map((e) => e.type));
  assert.ok((kinds.has("tool") || kinds.has("subagent")) && kinds.has("approval"), [...kinds].join());
  assert.ok(doc.trace.stats.toolCalls >= 3);
  assert.ok(!JSON.stringify(doc).includes("xai-AAAAAAAA"), "secret redacted in export");
  const only = filterByTool(t, "spawn_agent");
  assert.ok(only.events.some((e) => e.parent === "tool-1-b"), "sub-agent children kept");
});

await run("trace-archive-7d", () => {
  const dir = tmp("eval-trace-");
  const a = new TraceArchive(dir);
  a.upsert(fromJob(job()));
  assert.ok(a.get("job.evaljob1"));
  const mode = fs.statSync(path.join(dir, "traces", "job.evaljob1.json")).mode & 0o777;
  assert.equal(mode, 0o600);
});

await run("media-not-configured", async () => {
  const d = mediaDeps({ endpoints: [] });
  const r = await generateImage(d, "a cat", {}, sig());
  assert.equal(r.ok, false);
  assert.equal(r.code, "not_configured");
  assert.equal(r.status, 409);
  const v = await startVideo(d, "a cat", {}, sig());
  assert.equal(v.code, "not_configured", "video honest state, no fake");
  assert.equal(d.calls.length, 0, "no provider call");
  assert.equal(providersView(d).video.some((p) => p.configured), false);
});

await run("media-budget-trip", async () => {
  const d = mediaDeps({ budget: memBudget(0.1) });
  const first = await generateImage(d, "one", {}, sig());
  assert.equal(first.ok, true, first.message);
  const second = await generateImage(d, "two", {}, sig());
  assert.equal(second.ok, false);
  assert.equal(second.code, "budget");
  assert.equal(second.status, 402);
  assert.equal(d.calls.length, 1, "budget trips before the provider call");
  const capped = mediaDeps({ env: { SABLE_MEDIA_MAX_USD: "0.05" } });
  const c = await generateImage(capped, "x", {}, sig());
  assert.equal(c.code, "budget", "media cap");
});

await run("media-kill-switch", async () => {
  const d = mediaDeps({ env: { SABLE_MEDIA: "0" } });
  const r = await generateImage(d, "x", {}, sig());
  assert.equal(r.code, "disabled");
  assert.equal(r.status, 403);
  assert.equal(d.calls.length, 0);
});

await run("canvas-versions", () => {
  const s = new CanvasStore(tmp("eval-canvas-"));
  const c = s.create({ title: "eval", html: "<p>1</p>" });
  assert.ok(c.ok);
  assert.ok(s.update(c.canvas.id, { html: "<p>2</p>" }).ok);
  assert.equal(s.get(c.canvas.id).shownVersion, 2);
  assert.equal(s.get(c.canvas.id, 1).html, "<p>1</p>");
  assert.equal(s.list()[0].version, 2);
});

await run("canvas-csp-sandbox", () => {
  assert.equal(IFRAME_SANDBOX, "allow-scripts");
  assert.ok(/^sandbox allow-scripts;/.test(CANVAS_CSP));
  assert.ok(!CANVAS_CSP.includes("allow-same-origin"));
  assert.ok(CANVAS_CSP.includes("connect-src 'none'") && CANVAS_CSP.includes("default-src 'none'"));
});

// ---------- live (optional) ----------
const BASE = (process.env.SABLE_EVAL_URL || "http://localhost:8080").replace(/\/$/, "");
let live = false;
try {
  live = (await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3000) })).status < 500;
} catch {
  live = false;
}

if (!live) {
  skip("live-*", `${BASE} not reachable`);
} else {
  await run("live-traces-api", async () => {
    const r = await fetch(`${BASE}/api/traces?limit=5`);
    assert.equal(r.status, 200);
    const d = await r.json();
    if (d.enabled === false) return;
    assert.ok(Array.isArray(d.items));
    const first = d.items[0];
    if (first) {
      const e = await fetch(`${BASE}/api/traces/${encodeURIComponent(first.id)}?export=1`);
      assert.equal(e.status, 200);
      assert.match(e.headers.get("content-disposition") ?? "", /attachment/);
      assert.ok(isTraceExport(await e.json()));
    }
    assert.equal((await fetch(`${BASE}/api/traces/..%2Fetc`)).status, 400);
  });

  await run("live-media-list", async () => {
    const r = await fetch(`${BASE}/api/media?list=1`);
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.ok(Array.isArray(d.items));
    assert.ok(Array.isArray(d.providers?.image) && Array.isArray(d.providers?.video));
    for (const p of [...d.providers.image, ...d.providers.video]) assert.ok(p.configured || p.reason, `${p.id} reason`);
    assert.ok(!JSON.stringify(d).includes("xai-"), "no key in listing");
  });

  await run("live-canvas-version-and-csp", async () => {
    const post = (body) => fetch(`${BASE}/api/canvas`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const c = await (await post({ action: "create", title: "eval-w2", html: "<p id=a>1</p>" })).json();
    const id = c.canvas.id;
    try {
      assert.equal((await post({ action: "update", id, html: "<p id=a>2</p>", note: "eval" })).status, 200);
      const d = await (await fetch(`${BASE}/api/canvas/${id}?v=1`)).json();
      assert.equal(d.canvas.shownVersion, 1);
      assert.equal(d.canvas.versions.length, 2);
      const v = await fetch(`${BASE}/api/canvas/${id}/view`);
      assert.equal(v.status, 200);
      assert.equal(v.headers.get("content-security-policy"), CANVAS_CSP);
      assert.equal(v.headers.get("x-content-type-options"), "nosniff");
      assert.match(await v.text(), /<p id=a>2<\/p>/);
      assert.equal((await fetch(`${BASE}/api/canvas/c_doesnotexist0/view`)).status, 404);
    } finally {
      await post({ action: "delete", id });
    }
  });
}

const failed = results.filter((r) => r[0] === "FAIL").length;
console.log(`\n${results.filter((r) => r[0] === "PASS").length} pass · ${failed} fail · ${results.filter((r) => r[0] === "SKIP").length} skip`);
if (!failed) console.log("all w2 eval checks passed");
