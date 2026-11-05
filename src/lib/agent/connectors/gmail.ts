/**
 * W2b Gmail client (REST v1). Pure: every call goes through an injected
 * ApiCall (OAuthManager.request in the server, the mock in tests).
 */
import { call, type ApiCall } from "./http.ts";

export type GmailHeader = { name: string; value: string };
type Part = { mimeType?: string; filename?: string; body?: { data?: string; size?: number }; parts?: Part[]; headers?: GmailHeader[] };
export type RawMessage = { id: string; threadId: string; labelIds?: string[]; snippet?: string; internalDate?: string; payload?: Part };

export type MailSummary = {
  id: string;
  threadId: string;
  from: string;
  to: string;
  cc?: string;
  subject: string;
  date: string;
  at: number;
  labels: string[];
  snippet: string;
  body?: string;
  headers: Record<string, string>;
  attachments?: string[];
};

const MAX_BODY = 8_000;
const KEEP_HEADERS = ["from", "to", "cc", "subject", "date", "message-id", "list-unsubscribe", "auto-submitted", "precedence", "x-autoreply", "in-reply-to", "references"];

export const fromB64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
export const toB64url = (s: string | Buffer) => Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function findPart(p: Part | undefined, mime: string): Part | undefined {
  if (!p) return undefined;
  if (p.mimeType === mime && p.body?.data) return p;
  for (const c of p.parts ?? []) {
    const hit = findPart(c, mime);
    if (hit) return hit;
  }
  return undefined;
}
function attachments(p: Part | undefined, out: string[] = []) {
  if (!p) return out;
  if (p.filename) out.push(p.filename.slice(0, 120));
  for (const c of p.parts ?? []) attachments(c, out);
  return out;
}
const stripHtml = (h: string) =>
  h
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

export function summarize(m: RawMessage, withBody = false): MailSummary {
  const hs: Record<string, string> = {};
  for (const h of m.payload?.headers ?? []) {
    const k = h.name.toLowerCase();
    if (KEEP_HEADERS.includes(k) && !(k in hs)) hs[k] = h.value.slice(0, 500);
  }
  const at = Number(m.internalDate) || Date.parse(hs.date ?? "") || 0;
  const out: MailSummary = {
    id: m.id,
    threadId: m.threadId,
    from: hs.from ?? "",
    to: hs.to ?? "",
    ...(hs.cc ? { cc: hs.cc } : {}),
    subject: hs.subject ?? "(không tiêu đề)",
    date: hs.date ?? "",
    at,
    labels: m.labelIds ?? [],
    snippet: (m.snippet ?? "").slice(0, 300),
    headers: hs,
  };
  if (withBody) {
    const plain = findPart(m.payload, "text/plain");
    const html = plain ? undefined : findPart(m.payload, "text/html");
    const raw = plain?.body?.data ? fromB64url(plain.body.data) : html?.body?.data ? stripHtml(fromB64url(html.body.data)) : (m.snippet ?? "");
    out.body = raw.length > MAX_BODY ? `${raw.slice(0, MAX_BODY)}\n…[cắt bớt]` : raw;
    const files = attachments(m.payload);
    if (files.length) out.attachments = files.slice(0, 20);
  }
  return out;
}

const ADDR = /^[A-Za-z0-9._%+'-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;

/** Bare addresses only (no display names, no header injection). */
export function cleanAddresses(list: unknown, max = 20): string[] | string {
  const arr = Array.isArray(list) ? list : typeof list === "string" ? list.split(",") : [];
  const out = arr.map((x) => String(x).trim()).filter(Boolean);
  if (!out.length) return "cần ít nhất một địa chỉ";
  if (out.length > max) return `tối đa ${max} địa chỉ`;
  const bad = out.find((a) => !ADDR.test(a));
  return bad ? `địa chỉ không hợp lệ: ${bad.slice(0, 80)}` : out;
}

export type Compose = { to: string[]; cc?: string[]; subject: string; body: string; threadId?: string; inReplyTo?: string };

const encHeader = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`);

/** RFC 5322 text/plain message → base64url `raw`. CR/LF in header fields is refused. */
export function buildRaw(c: Compose): string {
  for (const v of [c.subject, c.inReplyTo ?? "", ...c.to, ...(c.cc ?? [])]) if (/[\r\n]/.test(v)) throw new Error("header không được chứa xuống dòng");
  const lines = [
    `To: ${c.to.join(", ")}`,
    ...(c.cc?.length ? [`Cc: ${c.cc.join(", ")}`] : []),
    `Subject: ${encHeader(c.subject)}`,
    ...(c.inReplyTo ? [`In-Reply-To: ${c.inReplyTo}`, `References: ${c.inReplyTo}`] : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(c.body, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n"),
  ];
  return toB64url(lines.join("\r\n"));
}

export type GmailClient = ReturnType<typeof gmailClient>;

export function gmailClient(base: string, api: ApiCall) {
  const u = (p: string, q?: Record<string, string | number | undefined>) => {
    const url = new URL(p, base);
    for (const [k, v] of Object.entries(q ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    return url.toString();
  };
  const enc = encodeURIComponent;
  return {
    async searchThreads(q: string, max = 10) {
      const r = await call<{ threads?: { id: string; snippet?: string }[] }>("Gmail", api, u("threads", { q, maxResults: Math.min(Math.max(max, 1), 25) }));
      return r.threads ?? [];
    },
    async thread(id: string) {
      const r = await call<{ id: string; messages?: RawMessage[] }>("Gmail", api, u(`threads/${enc(id)}`, { format: "full" }));
      return { id: r.id, messages: (r.messages ?? []).slice(-15).map((m) => summarize(m, true)) };
    },
    async message(id: string) {
      return summarize(await call<RawMessage>("Gmail", api, u(`messages/${enc(id)}`, { format: "full" })), true);
    },
    async labels() {
      const r = await call<{ labels?: { id: string; name: string; type?: string }[] }>("Gmail", api, u("labels"));
      return (r.labels ?? []).map((l) => ({ id: l.id, name: l.name, type: l.type }));
    },
    /** New-mail pull for triage: metadata only. */
    async recent(q = "in:inbox newer_than:2d", max = 25) {
      const r = await call<{ messages?: { id: string }[] }>("Gmail", api, u("messages", { q, maxResults: max }));
      const out: MailSummary[] = [];
      for (const m of (r.messages ?? []).slice(0, max)) {
        const full = await call<RawMessage>("Gmail", api, u(`messages/${enc(m.id)}`, { format: "full" }));
        out.push(summarize(full, true));
      }
      return out;
    },
    async createDraft(c: Compose) {
      const r = await call<{ id: string; message?: { id: string; threadId?: string } }>("Gmail", api, u("drafts"), {
        method: "POST",
        body: { message: { raw: buildRaw(c), ...(c.threadId ? { threadId: c.threadId } : {}) } },
      });
      return { draftId: r.id, messageId: r.message?.id };
    },
    async send(c: Compose) {
      const r = await call<{ id: string; threadId?: string }>("Gmail", api, u("messages/send"), {
        method: "POST",
        body: { raw: buildRaw(c), ...(c.threadId ? { threadId: c.threadId } : {}) },
      });
      return { messageId: r.id, threadId: r.threadId };
    },
  };
}
