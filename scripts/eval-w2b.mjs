/**
 * W2b eval (OAuth + Gmail + Calendar). Offline: full PKCE/state/refresh/revoke
 * flow against the local mock Google, send-needs-approval, background send
 * denied, calendar writes need approval, tokens redacted. Live: the running
 * Sable's connector registry / callback / vault guards (no real Google).
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OAuthManager, tokenName } from "../src/lib/agent/oauth/manager.ts";
import { googleDefs, GMAIL_SCOPES, GCAL_SCOPES } from "../src/lib/agent/connectors/google.ts";
import { startMockGoogle } from "../src/lib/agent/connectors/mock-google.ts";
import { gmailClient } from "../src/lib/agent/connectors/gmail.ts";
import { gmailTools } from "../src/lib/agent/connectors/gmail-tools.ts";
import { calendarClient } from "../src/lib/agent/connectors/calendar.ts";
import { calendarTools } from "../src/lib/agent/connectors/calendar-tools.ts";
import { VaultStore } from "../src/lib/agent/vault/store.ts";
import { redactSecrets } from "../src/lib/agent/memory/redact.ts";
import { execute } from "../src/lib/agent/tools/execute.ts";
import { BACKGROUND_KINDS, USER } from "../src/lib/agent/audit/types.ts";

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

const g = await startMockGoogle();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sable-eval-w2b-"));
const vault = new VaultStore(dir, { SABLE_VAULT_KEY: crypto.randomBytes(32).toString("base64") });
const REDIRECT = "https://sable.example.test/api/oauth/callback";
const defs = googleDefs(g.bases);
const mgr = new OAuthManager({
  providers: { google: defs.provider },
  connectors: defs.connectors,
  secrets: { get: (n) => vault.get(n), put: (n, v) => vault.put(n, v), remove: (n) => vault.remove(n), configured: () => vault.meta().configured },
  creds: () => ({ clientId: g.clientId, clientSecret: g.clientSecret }),
  redirectUri: () => REDIRECT,
  metaDir: dir,
  allowLoopbackHttp: true,
});
const consent = async (id) => {
  const { url } = mgr.begin(id);
  const back = new URL((await fetch(url, { redirect: "manual" })).headers.get("location"));
  return mgr.complete({ state: back.searchParams.get("state"), code: back.searchParams.get("code") });
};
const api = (id) => (url, init) => mgr.request(id, url, init);
const ctx = (over = {}) => ({ workspaceDir: dir, signal: new AbortController().signal, mode: "interactive", initiator: USER, audit: () => {}, ...over });
const byName = (list, n) => list.find((t) => t.name === n);

await run("oauth-scopes-least-privilege", () => {
  assert.ok(GMAIL_SCOPES.every((s) => /gmail\.(readonly|compose)$/.test(s)), "no full mail scope");
  assert.ok(GCAL_SCOPES.every((s) => /calendar\.(readonly|events)$/.test(s)));
});
await run("oauth-pkce-state-flow", async () => {
  const q = new URL(mgr.begin("gmail").url).searchParams;
  assert.equal(q.get("code_challenge_method"), "S256");
  assert.ok(q.get("state")?.length >= 40);
  await consent("gmail");
  await consent("gcal");
  assert.equal(mgr.status("gmail").status, "connected");
  assert.equal(mgr.status("gcal").status, "connected");
  await assert.rejects(mgr.complete({ state: q.get("state"), code: "x" }), /./, "unrelated/used state");
});
await run("oauth-tokens-vault-only", () => {
  const all = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
  for (const t of [...g.liveTokens().access, ...g.liveTokens().refresh]) assert.ok(!all.includes(t));
  assert.ok(vault.get(tokenName("gmail")));
});
await run("oauth-refresh-on-401", async () => {
  const n = g.stats.refreshes;
  g.expireAccessTokens();
  assert.equal((await mgr.request("gmail", `${g.bases.gmail}labels`)).status, 200);
  assert.equal(g.stats.refreshes, n + 1);
});
await run("oauth-host-allowlist", async () => {
  await assert.rejects(mgr.request("gmail", "https://example.com/x"), /./);
  await assert.rejects(mgr.request("gmail", `${g.bases.calendar}freeBusy`), /./);
});
await run("gmail-send-needs-approval", async () => {
  const send = byName(gmailTools(() => gmailClient(g.bases.gmail, api("gmail"))), "gmail_send");
  const args = JSON.stringify({ to: "a@example.com", subject: "s", body: "b" });
  assert.equal((await execute(send, args, ctx())).ok, false);
  assert.equal((await execute(send, args, ctx({ approve: async () => false }))).ok, false);
  assert.equal(g.sent.length, 0);
  assert.ok((await execute(send, args, ctx({ approve: async () => true }))).ok);
  assert.equal(g.sent.length, 1);
});
await run("gmail-background-send-denied", async () => {
  const send = byName(gmailTools(() => gmailClient(g.bases.gmail, api("gmail"))), "gmail_send");
  const args = JSON.stringify({ to: "a@example.com", subject: "s", body: "b" });
  for (const kind of BACKGROUND_KINDS) {
    let asked = 0;
    const r = await execute(send, args, ctx({ initiator: { kind, id: "x" }, approve: async () => (asked++, true) }));
    assert.equal(r.ok, false, kind);
    assert.equal(asked, 0, `${kind} reached an approval card`);
  }
  assert.equal(g.sent.length, 1);
});
await run("calendar-writes-need-approval", async () => {
  const tools = calendarTools(() => calendarClient(g.bases.calendar, api("gcal")));
  for (const n of ["cal_create_event", "cal_update_event", "cal_delete_event"]) assert.equal(byName(tools, n).needsApproval, true);
  const args = JSON.stringify({ summary: "x", start: "2026-11-06T09:00:00+07:00", end: "2026-11-06T10:00:00+07:00" });
  const n = g.events.size;
  assert.equal((await execute(byName(tools, "cal_create_event"), args, ctx({ approve: async () => false }))).ok, false);
  assert.equal(g.events.size, n);
  assert.ok((await execute(byName(tools, "cal_events"), JSON.stringify({ time_min: "2026-11-05T00:00:00Z", time_max: "2026-11-06T00:00:00Z" }), ctx())).ok);
});
await run("oauth-revoke", async () => {
  await mgr.revoke("gmail");
  assert.equal(vault.get(tokenName("gmail")), null);
  assert.equal(mgr.status("gmail").status, "needs-auth");
});
await run("tokens-redacted", () => {
  const { access, refresh } = g.liveTokens();
  const t = `Bearer ${access[0]} ${refresh[0]} ${g.clientSecret} ?code=4/abc {"refresh_token":"${refresh[0]}"}`;
  const out = redactSecrets(t).text;
  for (const s of [access[0], refresh[0], g.clientSecret]) assert.ok(!out.includes(s));
});
await g.close();
fs.rmSync(dir, { recursive: true, force: true });

// ---- live ----
const BASE = process.env.SABLE_EVAL_URL || "http://localhost:8080";
let live = false;
try {
  live = (await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(3000) })).ok;
} catch {
  live = false;
}
if (!live) skip("live", `${BASE} not reachable`);
else {
  await run("live-connectors-registry", async () => {
    const r = await fetch(`${BASE}/api/connectors`);
    assert.equal(r.status, 200);
    const text = await r.text();
    assert.doesNotMatch(text, /ya29\.|1\/\/|GOCSPX-|client_secret|access_token|refresh_token/);
    const d = JSON.parse(text);
    const ids = d.connectors.map((c) => c.id).sort();
    assert.deepEqual(ids, ["gcal", "gmail"]);
    for (const c of d.connectors) assert.ok(["off", "not-configured", "needs-auth", "connected", "error"].includes(c.status));
    assert.match(d.redirectUri ?? "", /^https:\/\/.+\/api\/oauth\/callback$/);
    console.log(`  connectors: ${d.connectors.map((c) => `${c.id}=${c.status}`).join(", ")}`);
  });
  await run("live-callback-bad-state", async () => {
    const r = await fetch(`${BASE}/api/oauth/callback?state=forged&code=x`);
    assert.ok([400, 403].includes(r.status));
    assert.equal(r.headers.get("referrer-policy"), "no-referrer");
    assert.match(r.headers.get("cache-control") ?? "", /no-store/);
    assert.match(r.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  });
  await run("live-connect-guarded", async () => {
    const d = await (await fetch(`${BASE}/api/connectors`)).json();
    const post = (b) => fetch(`${BASE}/api/connectors`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
    assert.equal((await post({ action: "connect", id: "nope" })).status, d.enabled ? 404 : 403);
    const gm = d.connectors.find((c) => c.id === "gmail");
    if (gm.status === "not-configured") assert.equal((await post({ action: "connect", id: "gmail" })).status, 409);
  });
  await run("live-vault-refuses-oauth-tokens", async () => {
    const r = await fetch(`${BASE}/api/vault`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "get", name: "OAUTH_TOKEN_GMAIL" }) });
    assert.equal(r.status, 403);
  });
  await run("live-brief-still-ok", async () => {
    const d = await (await fetch(`${BASE}/api/brief?preview=1`)).json();
    assert.match(d.preview.text, /Mọi gửi đi vẫn cần bạn duyệt/);
  });
}

const failed = results.filter((r) => r[0] === "FAIL").length;
console.log(`\n${results.filter((r) => r[0] === "PASS").length} pass · ${failed} fail · ${results.filter((r) => r[0] === "SKIP").length} skip`);
if (!failed) console.log("all w2b eval checks passed");
