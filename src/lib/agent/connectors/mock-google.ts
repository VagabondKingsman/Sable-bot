/**
 * W2b test double: a local mock of Google OAuth (authorize / token / revoke,
 * PKCE S256 verified) plus the Gmail and Calendar REST endpoints Sable uses.
 * Loopback only; used by unit tests and eval:w2b. Never shipped as a route.
 */
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { GoogleBases } from "./google.ts";

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const rand = () => b64url(crypto.randomBytes(18));

export type MockOpts = { clientId?: string; clientSecret?: string; expiresIn?: number };

export type MockGoogle = {
  base: string;
  bases: GoogleBases;
  clientId: string;
  clientSecret: string;
  stats: { authorize: number; codeExchanges: number; refreshes: number; revokes: number; apiCalls: number; unauthorized: number };
  sent: { raw: string; threadId?: string }[];
  drafts: { id: string; raw: string }[];
  events: Map<string, Record<string, unknown>>;
  /** Invalidate every live access token (forces a 401 → refresh). */
  expireAccessTokens(): void;
  liveTokens(): { access: string[]; refresh: string[] };
  close(): Promise<void>;
};

type Code = { clientId: string; redirectUri: string; challenge: string; scope: string; used: boolean };

const mail = (id: string, threadId: string, from: string, subject: string, body: string, labels: string[] = ["INBOX", "UNREAD"]) => ({
  id,
  threadId,
  labelIds: labels,
  snippet: body.slice(0, 80),
  internalDate: String(Date.parse("2026-11-05T01:00:00Z")),
  payload: {
    mimeType: "multipart/alternative",
    headers: [
      { name: "From", value: from },
      { name: "To", value: "owner@example.com" },
      { name: "Subject", value: subject },
      { name: "Date", value: "Thu, 05 Nov 2026 08:00:00 +0700" },
      { name: "Message-ID", value: `<${id}@mock>` },
    ],
    parts: [{ mimeType: "text/plain", body: { data: b64url(Buffer.from(body)) } }],
  },
});

export async function startMockGoogle(opts: MockOpts = {}): Promise<MockGoogle> {
  const clientId = opts.clientId ?? "mock-client.apps.googleusercontent.com";
  const clientSecret = opts.clientSecret ?? "GOCSPX-mockclientsecret0000";
  const codes = new Map<string, Code>();
  const access = new Map<string, { exp: number; refresh: string }>();
  const refresh = new Map<string, { scope: string }>();
  const stats = { authorize: 0, codeExchanges: 0, refreshes: 0, revokes: 0, apiCalls: 0, unauthorized: 0 };
  const sent: MockGoogle["sent"] = [];
  const drafts: MockGoogle["drafts"] = [];
  const events = new Map<string, Record<string, unknown>>([
    ["ev1", { id: "ev1", summary: "Họp team", start: { dateTime: "2026-11-05T09:00:00+07:00" }, end: { dateTime: "2026-11-05T10:00:00+07:00" }, status: "confirmed" }],
    ["ev2", { id: "ev2", summary: "Sinh nhật", start: { date: "2026-11-05" }, end: { date: "2026-11-06" }, status: "confirmed" }],
  ]);
  const messages = [
    mail("m1", "t1", "Lan <lan@example.com>", "Hợp đồng tháng 11", "Anh xem giúp hợp đồng và please confirm trước thứ Sáu nhé."),
    mail("m2", "t2", "Shop <deals@shop.example>", "Giảm 50% hôm nay", "Ưu đãi lớn!", ["INBOX", "CATEGORY_PROMOTIONS"]),
  ];
  const expiresIn = opts.expiresIn ?? 3600;

  const issue = (scope: string, rt?: string) => {
    const a = `ya29.mock-${rand()}`;
    const r = rt ?? `1//mock-${rand()}`;
    access.set(a, { exp: Date.now() + expiresIn * 1000, refresh: r });
    refresh.set(r, { scope });
    return { access_token: a, refresh_token: r, expires_in: expiresIn, scope, token_type: "Bearer" };
  };

  const readBody = (req: http.IncomingMessage) =>
    new Promise<string>((resolve) => {
      let s = "";
      req.on("data", (c) => (s += c));
      req.on("end", () => resolve(s));
    });
  const json = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const p = url.pathname;
    const raw = await readBody(req);
    // ---- OAuth ----
    if (p === "/o/oauth2/v2/auth" && req.method === "GET") {
      stats.authorize++;
      const q = url.searchParams;
      if (q.get("client_id") !== clientId || q.get("response_type") !== "code" || q.get("code_challenge_method") !== "S256" || !q.get("code_challenge") || !q.get("state") || !q.get("redirect_uri"))
        return json(res, 400, { error: "invalid_request" });
      const code = `4/mock-${rand()}`;
      codes.set(code, { clientId, redirectUri: q.get("redirect_uri")!, challenge: q.get("code_challenge")!, scope: q.get("scope") ?? "", used: false });
      const back = new URL(q.get("redirect_uri")!);
      if (q.get("deny") === "1") back.searchParams.set("error", "access_denied");
      else back.searchParams.set("code", code);
      back.searchParams.set("state", q.get("state")!);
      res.writeHead(302, { Location: back.toString() });
      return res.end();
    }
    if (p === "/token" && req.method === "POST") {
      const f = new URLSearchParams(raw);
      if (f.get("client_id") !== clientId || f.get("client_secret") !== clientSecret) return json(res, 401, { error: "invalid_client" });
      if (f.get("grant_type") === "authorization_code") {
        stats.codeExchanges++;
        const c = codes.get(f.get("code") ?? "");
        if (!c || c.used) return json(res, 400, { error: "invalid_grant", error_description: "bad code (echo ya29.should-not-leak)" });
        c.used = true;
        if (c.redirectUri !== f.get("redirect_uri")) return json(res, 400, { error: "redirect_uri_mismatch" });
        const ch = b64url(crypto.createHash("sha256").update(f.get("code_verifier") ?? "").digest());
        if (ch !== c.challenge) return json(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
        return json(res, 200, issue(c.scope));
      }
      if (f.get("grant_type") === "refresh_token") {
        stats.refreshes++;
        const r = refresh.get(f.get("refresh_token") ?? "");
        if (!r) return json(res, 400, { error: "invalid_grant" });
        const t = issue(r.scope, f.get("refresh_token")!);
        const { refresh_token: _drop, ...rest } = t; // Google omits refresh_token on refresh
        return json(res, 200, rest);
      }
      return json(res, 400, { error: "unsupported_grant_type" });
    }
    if (p === "/revoke" && req.method === "POST") {
      stats.revokes++;
      const tok = new URLSearchParams(raw).get("token") ?? "";
      if (refresh.has(tok)) {
        refresh.delete(tok);
        for (const [a, v] of access) if (v.refresh === tok) access.delete(a);
        return json(res, 200, {});
      }
      if (access.delete(tok)) return json(res, 200, {});
      return json(res, 400, { error: "invalid_token" });
    }
    // ---- APIs: bearer required ----
    const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    const a = access.get(bearer);
    if (!a || a.exp < Date.now() || !refresh.has(a.refresh)) {
      stats.unauthorized++;
      return json(res, 401, { error: { code: 401, message: "Invalid Credentials" } });
    }
    stats.apiCalls++;
    const body = raw ? JSON.parse(raw) : undefined;
    const gm = p.match(/^\/gmail\/v1\/users\/me\/(.*)$/);
    if (gm) {
      const r = gm[1];
      if (r === "threads" && req.method === "GET") return json(res, 200, { threads: messages.map((m) => ({ id: m.threadId, snippet: m.snippet })) });
      if (r.startsWith("threads/")) {
        const id = decodeURIComponent(r.slice(8));
        const ms = messages.filter((m) => m.threadId === id);
        return ms.length ? json(res, 200, { id, messages: ms }) : json(res, 404, { error: { code: 404, message: "Not found" } });
      }
      if (r === "messages" && req.method === "GET") return json(res, 200, { messages: messages.map((m) => ({ id: m.id })) });
      if (r === "messages/send" && req.method === "POST") {
        sent.push({ raw: body.raw, threadId: body.threadId });
        return json(res, 200, { id: `sent${sent.length}`, threadId: body.threadId ?? `ts${sent.length}` });
      }
      if (r.startsWith("messages/")) {
        const m = messages.find((x) => x.id === decodeURIComponent(r.slice(9)));
        return m ? json(res, 200, m) : json(res, 404, { error: { code: 404, message: "Not found" } });
      }
      if (r === "labels") return json(res, 200, { labels: [{ id: "INBOX", name: "INBOX", type: "system" }, { id: "Label_1", name: "Khách hàng", type: "user" }] });
      if (r === "drafts" && req.method === "POST") {
        const id = `d${drafts.length + 1}`;
        drafts.push({ id, raw: body.message.raw });
        return json(res, 200, { id, message: { id: `dm${drafts.length}` } });
      }
    }
    const cm = p.match(/^\/calendar\/v3\/(.*)$/);
    if (cm) {
      const r = cm[1];
      if (r === "users/me/calendarList") return json(res, 200, { items: [{ id: "primary", summary: "Owner", primary: true, accessRole: "owner", timeZone: "Asia/Saigon" }] });
      if (r === "freeBusy" && req.method === "POST")
        return json(res, 200, { calendars: Object.fromEntries((body.items as { id: string }[]).map((i) => [i.id, { busy: [{ start: "2026-11-05T02:00:00Z", end: "2026-11-05T03:00:00Z" }] }])) });
      const ev = r.match(/^calendars\/([^/]+)\/events(?:\/([^/]+))?$/);
      if (ev) {
        const eid = ev[2] ? decodeURIComponent(ev[2]) : null;
        if (!eid && req.method === "GET") return json(res, 200, { items: [...events.values()] });
        if (!eid && req.method === "POST") {
          const id = `ev${events.size + 1}`;
          const e = { id, status: "confirmed", ...body };
          events.set(id, e);
          return json(res, 200, e);
        }
        if (eid && !events.has(eid)) return json(res, 404, { error: { code: 404, message: "Not Found" } });
        if (eid && req.method === "PATCH") {
          const e = { ...events.get(eid)!, ...body };
          events.set(eid, e);
          return json(res, 200, e);
        }
        if (eid && req.method === "DELETE") {
          events.delete(eid);
          res.writeHead(204);
          return res.end();
        }
      }
    }
    return json(res, 404, { error: { code: 404, message: "no route" } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    bases: { auth: `${base}/o/oauth2/v2/auth`, token: `${base}/token`, revoke: `${base}/revoke`, gmail: `${base}/gmail/v1/users/me/`, calendar: `${base}/calendar/v3/` },
    clientId,
    clientSecret,
    stats,
    sent,
    drafts,
    events,
    expireAccessTokens() {
      for (const v of access.values()) v.exp = 0;
    },
    liveTokens: () => ({ access: [...access.keys()], refresh: [...refresh.keys()] }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
