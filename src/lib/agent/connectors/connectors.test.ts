/** W2b E2E: OAuth (PKCE/state/refresh/revoke) + Gmail + Calendar against a local mock Google. */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import type { Initiator } from "../audit/types.ts";
import { redactSecrets } from "../memory/redact.ts";
import { OAuthManager, tokenName } from "../oauth/manager.ts";
import { challengeOf } from "../oauth/pkce.ts";
import { composeBrief } from "../proactive/brief.ts";
import { triageOne } from "../proactive/triage.ts";
import { execute } from "../tools/execute.ts";
import type { ApprovalAsk, FunctionTool, ToolContext } from "../tools/types.ts";
import { VaultStore } from "../vault/store.ts";
import { calendarClient, dayBounds, eventBody } from "./calendar.ts";
import { calendarTools } from "./calendar-tools.ts";
import { gmailClient, fromB64url } from "./gmail.ts";
import { gmailTools, mailToTriage } from "./gmail-tools.ts";
import { googleDefs } from "./google.ts";
import { startMockGoogle, type MockGoogle } from "./mock-google.ts";
import { forSource } from "./select.ts";

let g: MockGoogle;
let dir: string;
let vault: VaultStore;
let mgr: OAuthManager;
let clock = Date.now();
const REDIRECT = "https://sable.example.test/api/oauth/callback";

function makeManager(over: Partial<ConstructorParameters<typeof OAuthManager>[0]> = {}) {
  const defs = googleDefs(g.bases);
  return new OAuthManager({
    providers: { google: defs.provider },
    connectors: defs.connectors,
    secrets: { get: (n) => vault.get(n), put: (n, v) => vault.put(n, v), remove: (n) => vault.remove(n), configured: () => vault.meta().configured },
    creds: () => ({ clientId: g.clientId, clientSecret: g.clientSecret }),
    redirectUri: () => REDIRECT,
    metaDir: dir,
    now: () => clock,
    allowLoopbackHttp: true,
    ...over,
  });
}

/** Plays the browser: open the auth URL, follow the 302 to our callback, hand the query to complete(). */
async function consent(m: OAuthManager, id: string, opts: { deny?: boolean; tamper?: (q: URLSearchParams) => void } = {}) {
  const { url } = m.begin(id);
  const u = new URL(url);
  if (opts.deny) u.searchParams.set("deny", "1");
  const r = await fetch(u, { redirect: "manual" });
  assert.equal(r.status, 302);
  const back = new URL(r.headers.get("location")!);
  assert.equal(`${back.origin}${back.pathname}`, REDIRECT);
  opts.tamper?.(back.searchParams);
  return { q: back.searchParams, res: m.complete({ state: back.searchParams.get("state"), code: back.searchParams.get("code"), error: back.searchParams.get("error") }) };
}

const USER: Initiator = { kind: "user", id: "owner:web" };
function ctx(over: Partial<ToolContext> = {}): ToolContext & { asks: ApprovalAsk[]; audits: unknown[] } {
  const asks: ApprovalAsk[] = [];
  const audits: unknown[] = [];
  return { workspaceDir: dir, signal: new AbortController().signal, mode: "interactive", initiator: USER, audit: (e: unknown) => audits.push(e), asks, audits, ...over } as never;
}
const approver = (answer: boolean, asks: ApprovalAsk[]) => async (a: ApprovalAsk) => {
  asks.push(a);
  return answer;
};
const tool = (list: FunctionTool<any>[], name: string) => list.find((t) => t.name === name)!;
const api = (id: string) => (url: string, init?: { method?: string; body?: unknown }) => mgr.request(id, url, init);

before(async () => {
  g = await startMockGoogle();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "sable-w2b-"));
  vault = new VaultStore(dir, { SABLE_VAULT_KEY: crypto.randomBytes(32).toString("base64") } as NodeJS.ProcessEnv);
  mgr = makeManager();
});
after(async () => {
  await g.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("status before consent: needs-auth; not-configured without vault key / client / redirect", () => {
  assert.equal(mgr.status("gmail").status, "needs-auth");
  const noVault = makeManager({ secrets: { get: () => null, put: () => ({ ok: false as const, error: "off" }), remove: () => false, configured: () => false } });
  assert.equal(noVault.status("gmail").status, "not-configured");
  assert.equal(makeManager({ creds: () => null }).status("gcal").status, "not-configured");
  assert.equal(makeManager({ redirectUri: () => null }).status("gcal").status, "not-configured");
  assert.equal(makeManager({ enabled: () => false }).status("gmail").status, "off");
  assert.throws(() => noVault.begin("gmail"), /./);
});

test("begin builds a PKCE S256 + state authorization URL with the right scopes", () => {
  const { url, state } = mgr.begin("gmail");
  const q = new URL(url).searchParams;
  assert.equal(q.get("response_type"), "code");
  assert.equal(q.get("code_challenge_method"), "S256");
  assert.match(q.get("code_challenge")!, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(q.get("state"), state);
  assert.equal(q.get("redirect_uri"), REDIRECT);
  assert.equal(q.get("access_type"), "offline");
  assert.match(q.get("scope")!, /gmail\.readonly/);
  assert.match(q.get("scope")!, /gmail\.compose/);
  assert.doesNotMatch(url, /code_verifier|client_secret/);
  assert.equal(challengeOf("abc").length, 43);
});

test("auth-code flow stores tokens only in the encrypted vault; state is single-use", async () => {
  const { q, res } = await consent(mgr, "gmail");
  assert.deepEqual(await res, { connectorId: "gmail" });
  assert.equal(mgr.status("gmail").status, "connected");
  const [access] = g.liveTokens().access;
  const [refresh] = g.liveTokens().refresh;
  const onDisk = fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n");
  assert.ok(!onDisk.includes(access) && !onDisk.includes(refresh), "no plaintext token on disk");
  assert.ok(vault.meta().names.includes(tokenName("gmail")));
  assert.ok(vault.get(tokenName("gmail"))!.includes(access), "vault decrypts to the token");
  const metaFile = path.join(dir, "oauth.json");
  assert.equal(fs.statSync(metaFile).mode & 0o777, 0o600);
  // replaying the same state is refused
  await assert.rejects(mgr.complete({ state: q.get("state"), code: q.get("code") }), (e: Error) => /state/i.test(`${(e as { code?: string }).code} ${e.message}`));
  await assert.rejects(mgr.complete({ state: "forged", code: "x" }), /./);
});

test("consent denied / tampered code → error without leaking the provider body", async () => {
  const denied = await consent(mgr, "gcal", { deny: true });
  await assert.rejects(denied.res, /./);
  const bad = await consent(mgr, "gcal", { tamper: (q) => q.set("code", "4/mock-wrong") });
  await bad.res.then(
    () => assert.fail("should reject"),
    (e: Error) => {
      assert.doesNotMatch(e.message, /ya29|should-not-leak/);
      assert.equal((e as { code?: string }).code, "invalid_grant");
    },
  );
  assert.equal(mgr.status("gcal").status, "error");
  // and a clean retry still works
  await (await consent(mgr, "gcal")).res;
  assert.equal(mgr.status("gcal").status, "connected");
});

test("refresh before expiry, and a 401 forces exactly one refresh + retry", async () => {
  const before = g.stats.refreshes;
  clock += 3_600_000; // past expiry per our clock → proactive refresh
  const r1 = await mgr.request("gmail", `${g.bases.gmail}labels`);
  assert.equal(r1.status, 200);
  assert.equal(g.stats.refreshes, before + 1);
  g.expireAccessTokens(); // server-side revocation of the access token → 401
  const r2 = await mgr.request("gmail", `${g.bases.gmail}labels`);
  assert.equal(r2.status, 200);
  assert.equal(g.stats.refreshes, before + 2);
  assert.ok(vault.get(tokenName("gmail")), "refresh token kept after refresh");
});

test("requests are confined to the connector's API bases", async () => {
  await assert.rejects(mgr.request("gmail", `${g.bases.calendar}users/me/calendarList`), /./);
  await assert.rejects(mgr.request("gmail", "https://evil.example/gmail/v1/users/me/labels"), /./);
  await assert.rejects(makeManager({ allowLoopbackHttp: false }).request("gmail", `${g.bases.gmail}labels`), /./);
});

test("gmail read tools return fenced content via the mock", async () => {
  const tools = gmailTools(() => gmailClient(g.bases.gmail, api("gmail")));
  const c = ctx();
  const s = await execute(tool(tools, "gmail_search"), JSON.stringify({ query: "in:inbox" }), c);
  assert.ok(s.ok, s.output);
  const t = await execute(tool(tools, "gmail_read_thread"), JSON.stringify({ thread_id: "t1" }), c);
  assert.ok(t.ok, t.output);
  assert.match(t.output, /untrusted content/);
  assert.match(t.output, /Hợp đồng tháng 11/);
  const l = await execute(tool(tools, "gmail_labels"), "{}", c);
  assert.match(l.output, /Khách hàng/);
});

test("gmail_draft creates a draft (audited); nothing is sent", async () => {
  const tools = gmailTools(() => gmailClient(g.bases.gmail, api("gmail")));
  const c = ctx();
  const r = await execute(tool(tools, "gmail_draft"), JSON.stringify({ to: "lan@example.com", subject: "Re: Hợp đồng", body: "Em gửi lại ạ" }), c);
  assert.ok(r.ok, r.output);
  assert.equal(g.drafts.length, 1);
  assert.equal(g.sent.length, 0);
  assert.equal((c.audits[0] as { initiator: Initiator }).initiator.kind, "user");
});

test("gmail_send needs approval: no approver → refused; rejected → not sent; approved → sent once", async () => {
  const tools = gmailTools(() => gmailClient(g.bases.gmail, api("gmail")));
  const send = tool(tools, "gmail_send");
  assert.equal(send.needsApproval, true);
  assert.equal(send.risk, "write");
  const args = JSON.stringify({ to: "lan@example.com", subject: "Xác nhận", body: "Anh đồng ý." });
  const none = await execute(send, args, ctx());
  assert.equal(none.ok, false);
  assert.match(none.output, /approval/);
  const c1 = ctx();
  const no = await execute(send, args, { ...c1, approve: approver(false, c1.asks) });
  assert.equal(no.ok, false);
  assert.equal(c1.asks.length, 1);
  assert.match(c1.asks[0].summary, /lan@example\.com/);
  assert.match(`${c1.asks[0].summary}\n${c1.asks[0].preview ?? ""}`, /Xác nhận|Anh đồng ý/);
  assert.equal(g.sent.length, 0);
  const c2 = ctx();
  const yes = await execute(send, args, { ...c2, approve: approver(true, c2.asks) });
  assert.ok(yes.ok, yes.output);
  assert.equal(g.sent.length, 1);
  assert.match(fromB64url(g.sent[0].raw), /To: lan@example\.com/);
  const mime = fromB64url(g.sent[0].raw);
  assert.equal(Buffer.from(mime.split("\r\n\r\n")[1], "base64").toString("utf8"), "Anh đồng ý.");
});

test("background initiators can never send, even with an approver that says yes", async () => {
  const tools = gmailTools(() => gmailClient(g.bases.gmail, api("gmail")));
  const send = tool(tools, "gmail_send");
  const args = JSON.stringify({ to: "lan@example.com", subject: "x", body: "y" });
  const sentBefore = g.sent.length;
  const kinds: Initiator[] = [
    { kind: "routine", id: "r1" },
    { kind: "trigger", id: "w1" },
    { kind: "agent", id: "p:1" },
    { kind: "subagent", id: "s1" },
    { kind: "user", id: "owner:web", via: { kind: "routine", id: "r1" } },
  ];
  for (const initiator of kinds) {
    const c = ctx({ initiator });
    const r = await execute(send, args, { ...c, approve: approver(true, c.asks) });
    assert.equal(r.ok, false, initiator.kind);
    assert.equal(c.asks.length, 0, `${initiator.kind}: refused before any approval card`);
    assert.equal((c.audits[0] as { initiator: Initiator; ok: boolean }).initiator.kind, initiator.kind);
    assert.equal((c.audits[0] as { ok: boolean }).ok, false);
  }
  const anon = await execute(send, args, { ...ctx(), initiator: undefined, approve: async () => true });
  assert.equal(anon.ok, false);
  assert.equal(g.sent.length, sentBefore);
  // routine sources do not even see approval-needing connector tools
  const names = forSource([...tools, ...calendarTools(() => null)], "routine").map((t) => t.name);
  assert.ok(!names.includes("gmail_send") && !names.includes("cal_create_event"));
  assert.ok(names.includes("gmail_search") && names.includes("cal_events"));
});

test("header injection in compose is refused", async () => {
  const send = tool(gmailTools(() => gmailClient(g.bases.gmail, api("gmail"))), "gmail_send");
  const c = ctx();
  const r = await execute(send, JSON.stringify({ to: "a@example.com\r\nBcc: x@evil.example", subject: "s", body: "b" }), { ...c, approve: approver(true, c.asks) });
  assert.equal(r.ok, false);
});

test("new mail feeds triage (promotions ignored, asks need a reply)", async () => {
  const client = gmailClient(g.bases.gmail, api("gmail"));
  const mails = await client.recent();
  assert.equal(mails.length, 2);
  const verdicts = await Promise.all(mails.map((m) => triageOne(mailToTriage(m))));
  const byId = Object.fromEntries(mails.map((m, i) => [m.id, verdicts[i]]));
  assert.equal(byId.m2.bucket, "ignore");
  assert.notEqual(byId.m1.bucket, "ignore");
  assert.equal(mailToTriage(mails[0]).id, `gmail:${mails[0].id}`);
});

test("calendar: list, free/busy, and writes only through approval (no invites sent)", async () => {
  const tools = calendarTools(() => calendarClient(g.bases.calendar, api("gcal")));
  const c = ctx();
  const ev = await execute(tool(tools, "cal_events"), JSON.stringify({ time_min: "2026-11-05T00:00:00+07:00", time_max: "2026-11-06T00:00:00+07:00" }), c);
  assert.ok(ev.ok, ev.output);
  assert.match(ev.output, /Họp team/);
  const fb = await execute(tool(tools, "cal_freebusy"), JSON.stringify({ time_min: "2026-11-05T00:00:00Z", time_max: "2026-11-06T00:00:00Z" }), c);
  assert.match(fb.output, /primary: 2026-11-05T02:00:00Z/);
  for (const n of ["cal_create_event", "cal_update_event", "cal_delete_event"]) assert.equal(tool(tools, n).needsApproval, true, n);
  const create = JSON.stringify({ summary: "Gặp Lan", start: "2026-11-06T09:00:00+07:00", end: "2026-11-06T10:00:00+07:00" });
  const n0 = g.events.size;
  assert.equal((await execute(tool(tools, "cal_create_event"), create, ctx())).ok, false);
  const c1 = ctx();
  assert.equal((await execute(tool(tools, "cal_create_event"), create, { ...c1, approve: approver(false, c1.asks) })).ok, false);
  assert.match(c1.asks[0].summary, /Gặp Lan/);
  assert.equal(g.events.size, n0);
  const c2 = ctx();
  const ok = await execute(tool(tools, "cal_create_event"), create, { ...c2, approve: approver(true, c2.asks) });
  assert.ok(ok.ok, ok.output);
  assert.equal(g.events.size, n0 + 1);
  const c3 = ctx();
  assert.ok((await execute(tool(tools, "cal_update_event"), JSON.stringify({ event_id: "ev1", summary: "Họp team (dời)" }), { ...c3, approve: approver(true, c3.asks) })).ok);
  assert.equal(g.events.get("ev1")!.summary, "Họp team (dời)");
  const c4 = ctx();
  assert.ok((await execute(tool(tools, "cal_delete_event"), JSON.stringify({ event_id: "ev1" }), { ...c4, approve: approver(true, c4.asks) })).ok);
  assert.ok(!g.events.has("ev1"));
  // invalid times are refused before the approval card
  const c5 = ctx();
  const bad = await execute(tool(tools, "cal_create_event"), JSON.stringify({ summary: "x", start: "tomorrow", end: "later" }), { ...c5, approve: approver(true, c5.asks) });
  assert.equal(bad.ok, false);
  assert.equal(c5.asks.length, 0);
  assert.equal(typeof eventBody({ summary: "x", start: "2026-11-06T10:00:00Z", end: "2026-11-06T09:00:00Z" }), "string");
});

test("dayBounds gives the local day in the owner's zone", () => {
  const { start, end } = dayBounds(new Date("2026-11-05T20:30:00Z"), "Asia/Saigon"); // 03:30 on Nov 6 ICT
  assert.equal(new Date(start).toISOString(), "2026-11-05T17:00:00.000Z");
  assert.equal(end - start, 86_400_000);
});

test("today's events appear in the morning brief", () => {
  const b = composeBrief({
    now: new Date("2026-11-05T00:30:00Z"),
    tz: "Asia/Saigon",
    triaged: [],
    approvals: [],
    tasks: [],
    budget: null as never,
    events: [
      { summary: "Họp team", start: "2026-11-05T09:00:00+07:00", end: "2026-11-05T10:00:00+07:00" },
      { summary: "Sinh nhật", start: "2026-11-05", allDay: true },
    ],
  });
  const text = JSON.stringify(b);
  assert.match(text, /Lịch hôm nay \(2\)/);
  assert.match(text, /09:00–10:00 Họp team/);
  assert.match(text, /cả ngày Sinh nhật/);
  const none = JSON.stringify(composeBrief({ now: new Date(), tz: "Asia/Saigon", triaged: [], approvals: [], tasks: [], budget: null as never }));
  assert.doesNotMatch(none, /Lịch hôm nay/);
});

test("revoke removes the token from the vault and the provider", async () => {
  const before = g.stats.revokes;
  await mgr.revoke("gmail");
  assert.equal(g.stats.revokes, before + 1);
  assert.equal(vault.get(tokenName("gmail")), null);
  assert.equal(mgr.status("gmail").status, "needs-auth");
  await assert.rejects(mgr.request("gmail", `${g.bases.gmail}labels`), /./);
});

test("tokens are redacted from any text that could reach logs, traces or audit", () => {
  const { access, refresh } = g.liveTokens();
  const sample = `GET ${REDIRECT}?code=4/mock-abc&state=s  Authorization: Bearer ${access[0]} refresh=${refresh[0]} {"access_token":"${access[0]}","refresh_token":"${refresh[0]}"} secret ${g.clientSecret}`;
  const out = redactSecrets(sample).text;
  for (const t of [access[0], refresh[0], g.clientSecret, "4/mock-abc"]) assert.ok(!out.includes(t), `leaked ${t.slice(0, 6)}…`);
  // the meta file never holds a token
  const meta = fs.readFileSync(path.join(dir, "oauth.json"), "utf8");
  for (const t of [...access, ...refresh]) assert.ok(!meta.includes(t));
});
