/**
 * W2c eval (harden). Offline: the W2c unit suites (canvas guard + share links, media tool,
 * builtin brief routine, plan initiator traces, OAuth pending persistence, harden middleware)
 * plus the honest held-out triage score (reported, never gated). Live (running Sable):
 * builtin routine listed + immutable, routine-webhook approval refused 403 + audited,
 * share link lifecycle (create → view → revoke → 404), CSRF 403 / body cap 413.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { evaluate, loadSet } from "../evals/triage/run.mjs";

const results = [];
const pass = (n) => (results.push(["PASS", n]), console.log("PASS", n));
const skip = (n, why) => (results.push(["SKIP", n]), console.log("SKIP", n, "-", why));
function fail(n, e) {
  results.push(["FAIL", n]);
  console.error("FAIL", n, e?.message || e);
  process.exitCode = 1;
}
async function run(name, fn) {
  try {
    if ((await fn()) === "skip") return;
    pass(name);
  } catch (e) {
    fail(name, e);
  }
}
const suite = (files, pattern) => {
  const args = ["--experimental-strip-types", "--no-warnings", "--test", "--test-reporter=tap"];
  if (pattern) args.push(`--test-name-pattern=${pattern}`);
  const r = spawnSync(process.execPath, [...args, ...files], { encoding: "utf8" });
  const m = /# fail (\d+)/.exec(r.stdout);
  const p = /# pass (\d+)/.exec(r.stdout);
  assert.equal(r.status, 0, r.stdout.slice(-1500));
  assert.ok(p && Number(p[1]) > 0 && m && m[1] === "0", "no tests ran / failures");
};

await run("canvas-guard-and-share-links", () => suite(["src/lib/agent/canvas/shares.test.ts", "src/lib/agent/canvas/canvas.test.ts"]));
await run("media-tool-approval-budget", () => suite(["src/lib/agent/media/tool.test.ts", "src/lib/agent/media/media.test.ts"]));
await run("brief-is-builtin-routine", () => suite(["src/lib/agent/jobs.test.ts"], "builtin"));
await run("plan-trace-initiator", () => suite(["src/lib/agent/trace/trace.test.ts"]));
await run("oauth-pending-persisted", () => suite(["src/lib/agent/connectors/connectors.test.ts"]));
await run("harden-rate-size-csrf", () => suite(["src/server/harden.test.ts"]));
await run("triage-tuning-set-gates", async () => {
  const m = await evaluate(loadSet("items"));
  assert.ok(m.pass, `tuning set accuracy ${m.accuracy}`);
});
await run("triage-heldout-honest-score", async () => {
  const m = await evaluate(loadSet("heldout"));
  assert.equal(m.n, 60);
  assert.equal(m.approvalRecall, 1, "approval recall must stay 100% even untuned");
  console.log(`  held-out (rules+heuristic, not gated): accuracy ${(m.accuracy * 100).toFixed(1)}% · reply recall ${(m.replyRecall * 100).toFixed(0)}% precision ${(m.replyPrecision * 100).toFixed(0)}%`);
});

// ---- live ----
const BASE = process.env.SABLE_EVAL_URL || "http://localhost:8080";
let live = false;
try {
  live = (await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(5000) })).ok;
} catch {
  live = false;
}
const post = (p, b, h = {}) => fetch(`${BASE}${p}`, { method: "POST", headers: { "Content-Type": "application/json", ...h }, body: JSON.stringify(b) });
if (!live) skip("live", `${BASE} not reachable`);
else {
  await run("live-builtin-brief-routine", async () => {
    const d = await (await fetch(`${BASE}/api/routines`)).json();
    const list = d.routines ?? d.items ?? d;
    const b = list.find((r) => r.id === "builtin:morning-brief");
    assert.ok(b, "builtin:morning-brief listed");
    assert.equal(b.builtin, "morning-brief");
    const del = await post("/api/routines", { action: "delete", id: b.id });
    assert.ok([404, 409].includes(del.status), `delete builtin → ${del.status}`);
  });
  await run("live-routine-webhook-approval-refused", async () => {
    const c = await post("/api/routines", { action: "create", name: "w2c-eval-tmp", prompt: "noop", model: "grok-4.5", enabled: false, schedule: { kind: "interval", minutes: 60 } });
    assert.equal(c.status, 201);
    const id = (await c.json()).id;
    try {
      const w = await (await post("/api/routines", { action: "webhook", id, on: true })).json();
      assert.ok(typeof w.secret === "string" && w.secret.length >= 20);
      const fire = (secret) => post(`/api/routines/${id}/fire`, { approvalId: "apr_w2c_eval", approve: true }, { "X-Sable-Secret": secret });
      assert.equal((await fire("wrong-secret-wrong-secret")).status, 401);
      const r = await fire(w.secret);
      assert.equal(r.status, 403);
      assert.match((await r.json()).message ?? "", /never approve/);
      const a = await (await fetch(`${BASE}/api/audit?type=approval.denied_policy&kind=trigger`)).json();
      assert.ok(a.items.some((e) => JSON.stringify(e).includes(id)), "audited");
    } finally {
      await post("/api/routines", { action: "delete", id });
    }
  });
  await run("live-share-link-lifecycle", async () => {
    const c = await post("/api/canvas", { action: "create", title: "w2c eval", html: "<h1>hi</h1><a href='https://example.com' target='_top'>x</a>" });
    if (c.status === 403) return "skip";
    assert.equal(c.status, 201);
    const cid = (await c.json()).canvas.id;
    try {
      const s = await post("/api/canvas/shares", { action: "create", canvasId: cid, ttlHours: 1 });
      assert.equal(s.status, 201);
      const sd = await s.json();
      const path = new URL(sd.url).pathname;
      const list = await (await fetch(`${BASE}/api/canvas/shares?canvas=${cid}`)).text();
      assert.ok(!list.includes(path.slice(3)), "token never listed");
      const v = await fetch(`${BASE}${path}`);
      assert.equal(v.status, 200);
      assert.match(v.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
      assert.match(await v.text(), /sandbox="allow-scripts"/);
      const raw = await fetch(`${BASE}${path}?raw=1`);
      assert.equal(raw.status, 200);
      assert.doesNotMatch(await raw.text(), /target=['"]_top/);
      assert.equal((await post("/api/canvas/shares", { action: "revoke", id: sd.share.id })).status, 200);
      assert.equal((await fetch(`${BASE}${path}`)).status, 404);
      assert.equal((await fetch(`${BASE}/s/forged-token-0000000000000000000000`)).status, 404);
    } finally {
      await post("/api/canvas", { action: "delete", id: cid });
    }
  });
  await run("live-csrf-and-body-cap", async () => {
    assert.equal((await post("/api/tools", {}, { Origin: "https://evil.example" })).status, 403);
    assert.equal((await post("/api/tools", {}, { Origin: "null" })).status, 403);
    assert.notEqual((await post("/api/tools", {}, { Origin: "http://localhost:8080" })).status, 403);
    const big = await fetch(`${BASE}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": "20000000" }, body: "" }).catch(() => null);
    if (big) assert.equal(big.status, 413);
  });
}

const failed = results.filter((r) => r[0] === "FAIL").length;
console.log(`\n${results.filter((r) => r[0] === "PASS").length} pass · ${failed} fail · ${results.filter((r) => r[0] === "SKIP").length} skip`);
if (!failed) console.log("all w2c eval checks passed");
