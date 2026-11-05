/**
 * W2b Gmail agent tools. Reads are free; a draft is an audited side effect
 * (nothing leaves the mailbox); gmail_send ALWAYS goes through the approval
 * card and is refused outright for background initiators
 * (routine / trigger / agent / subagent) — only the owner (web or an owner
 * channel) can start a send, and only the owner can approve it (W2a policy).
 */
import { BACKGROUND_KINDS } from "../audit/types.ts";
import type { TriageInput } from "../proactive/triage.ts";
import type { FunctionTool, ToolContext } from "../tools/types.ts";
import { cleanAddresses, type Compose, type GmailClient, type MailSummary } from "./gmail.ts";
import { fence } from "./http.ts";

type Get = () => GmailClient | null;
const NOT = "Gmail chưa kết nối (Cài đặt → Kết nối).";
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function mailToTriage(m: MailSummary): TriageInput {
  return {
    id: `gmail:${m.id}`,
    source: "mail",
    from: m.from,
    to: m.to ? m.to.split(",").map((s) => s.trim()) : [],
    cc: m.cc ? m.cc.split(",").map((s) => s.trim()) : [],
    title: clip(m.subject, 200),
    body: clip(m.body ?? m.snippet, 2_000),
    at: m.at || Date.now(),
    headers: m.headers,
    labels: m.labels,
    meta: { kind: "message", fromOwner: false },
  };
}

const show = (m: MailSummary) =>
  [`id: ${m.id} · thread: ${m.threadId}`, `From: ${m.from}`, `To: ${m.to}`, m.cc ? `Cc: ${m.cc}` : "", `Subject: ${m.subject}`, `Date: ${m.date}`, `Labels: ${m.labels.join(", ")}`, m.attachments?.length ? `Attachments: ${m.attachments.join(", ")}` : "", "", m.body ?? m.snippet]
    .filter((l, i) => l !== "" || i === 8)
    .join("\n");

/** Background initiators may never send mail. Missing initiator counts as background. */
export function sendRefusal(ctx: ToolContext): string | null {
  const who = ctx.initiator;
  if (!who) return "gmail_send bị từ chối: không rõ ai khởi tạo lượt chạy này.";
  if (BACKGROUND_KINDS.includes(who.kind)) return `gmail_send bị từ chối: initiator ${who.kind} không bao giờ được gửi thư (chỉ bạn mới khởi tạo gửi, và luôn qua thẻ duyệt).`;
  if (who.via && BACKGROUND_KINDS.includes(who.via.kind)) return `gmail_send bị từ chối: chuỗi chạy bắt đầu từ ${who.via.kind}.`;
  return null;
}

type ComposeArgs = { to: string; cc?: string; subject: string; body: string; thread_id?: string; in_reply_to?: string };
const composeSchema = {
  type: "object",
  properties: {
    to: { type: "string", description: "Comma-separated bare email addresses" },
    cc: { type: "string" },
    subject: { type: "string" },
    body: { type: "string", description: "Plain-text body" },
    thread_id: { type: "string" },
    in_reply_to: { type: "string", description: "Message-ID header of the mail being answered" },
  },
  required: ["to", "subject", "body"],
} as const;

function toCompose(a: ComposeArgs): Compose | string {
  const to = cleanAddresses(a.to);
  if (typeof to === "string") return `to: ${to}`;
  const cc = a.cc ? cleanAddresses(a.cc) : [];
  if (typeof cc === "string") return `cc: ${cc}`;
  if (!a.subject.trim() || a.subject.length > 300 || /[\r\n]/.test(a.subject)) return "subject: 1..300 ký tự, một dòng";
  if (a.body.length > 50_000) return "body quá dài";
  if (a.in_reply_to && (/[\r\n]/.test(a.in_reply_to) || a.in_reply_to.length > 300)) return "in_reply_to không hợp lệ";
  return { to, cc, subject: a.subject.trim(), body: a.body, ...(a.thread_id ? { threadId: a.thread_id } : {}), ...(a.in_reply_to ? { inReplyTo: a.in_reply_to } : {}) };
}

export function gmailTools(get: Get): FunctionTool<any>[] {
  const need = () => {
    const g = get();
    if (!g) throw new Error(NOT);
    return g;
  };
  const search: FunctionTool<{ query: string; max?: number }> = {
    kind: "function",
    name: "gmail_search",
    description: "Search the owner's Gmail threads (Gmail query syntax, e.g. `from:x newer_than:7d`). Returns thread ids + snippets.",
    parameters: { type: "object", properties: { query: { type: "string" }, max: { type: "number" } }, required: ["query"] },
    risk: "read",
    timeoutMs: 30_000,
    maxOutput: 12_000,
    label: (a) => `gmail_search · ${clip(a.query, 60)}`,
    run: async (a) => {
      const threads = await need().searchThreads(a.query.slice(0, 300), a.max ?? 10);
      if (!threads.length) return { ok: true, output: "Không có thread nào khớp." };
      return { ok: true, output: fence("EMAIL", threads.map((t) => `thread ${t.id}: ${t.snippet ?? ""}`).join("\n")) };
    },
  };
  const readThread: FunctionTool<{ thread_id: string }> = {
    kind: "function",
    name: "gmail_read_thread",
    description: "Read one Gmail thread (last 15 messages, plain text).",
    parameters: { type: "object", properties: { thread_id: { type: "string" } }, required: ["thread_id"] },
    risk: "read",
    timeoutMs: 30_000,
    maxOutput: 30_000,
    label: (a) => `gmail_read_thread · ${a.thread_id.slice(0, 40)}`,
    run: async (a) => {
      const t = await need().thread(a.thread_id);
      return { ok: true, output: fence("EMAIL", t.messages.map(show).join("\n\n---\n\n")) };
    },
  };
  const readMessage: FunctionTool<{ message_id: string }> = {
    kind: "function",
    name: "gmail_read_message",
    description: "Read one Gmail message (headers + plain-text body).",
    parameters: { type: "object", properties: { message_id: { type: "string" } }, required: ["message_id"] },
    risk: "read",
    timeoutMs: 30_000,
    maxOutput: 12_000,
    label: (a) => `gmail_read_message · ${a.message_id.slice(0, 40)}`,
    run: async (a) => ({ ok: true, output: fence("EMAIL", show(await need().message(a.message_id))) }),
  };
  const labels: FunctionTool<Record<string, never>> = {
    kind: "function",
    name: "gmail_labels",
    description: "List the owner's Gmail labels.",
    parameters: { type: "object", properties: {}, required: [] },
    risk: "read",
    timeoutMs: 20_000,
    maxOutput: 6_000,
    label: () => "gmail_labels",
    run: async () => ({ ok: true, output: (await need().labels()).map((l) => `${l.id}: ${l.name}`).join("\n") || "(không có nhãn)" }),
  };
  const draft: FunctionTool<ComposeArgs> = {
    kind: "function",
    name: "gmail_draft",
    description: "Create a Gmail DRAFT (not sent). The owner reviews and sends it themselves, or asks you to send via gmail_send (approval card).",
    parameters: composeSchema as never,
    risk: "network",
    timeoutMs: 30_000,
    maxOutput: 2_000,
    label: (a) => `gmail_draft · ${clip(a.to, 60)} · ${clip(a.subject, 60)}`,
    check: async (a) => {
      const c = toCompose(a);
      return typeof c === "string" ? c : null;
    },
    run: async (a) => {
      const c = toCompose(a) as Compose;
      const r = await need().createDraft(c);
      return { ok: true, output: `Đã tạo nháp ${r.draftId} (chưa gửi) cho ${c.to.join(", ")}.` };
    },
  };
  const send: FunctionTool<ComposeArgs> = {
    kind: "function",
    name: "gmail_send",
    description: "SEND an email from the owner's Gmail. Always shows the owner an approval card with the exact recipients, subject and body; never available to routines/triggers/sub-agents.",
    parameters: composeSchema as never,
    risk: "write",
    needsApproval: true,
    timeoutMs: 30_000,
    maxOutput: 2_000,
    label: (a) => `gmail_send · ${clip(a.to, 60)} · ${clip(a.subject, 60)}`,
    describe: (a) => ({
      tool: "gmail_send",
      summary: `Gửi email tới ${clip(a.to, 200)}${a.cc ? ` (cc ${clip(a.cc, 120)})` : ""}: “${clip(a.subject, 120)}”`,
      preview: clip(a.body, 4_000),
    }),
    check: async (a, ctx) => {
      const refused = sendRefusal(ctx);
      if (refused) return refused;
      const c = toCompose(a);
      return typeof c === "string" ? c : null;
    },
    run: async (a, ctx) => {
      // Re-check after the approval wait (defence in depth; the ctx cannot change, but be explicit).
      const refused = sendRefusal(ctx);
      if (refused) return { ok: false, output: refused };
      const c = toCompose(a) as Compose;
      const r = await need().send(c);
      return { ok: true, output: `Đã gửi (message ${r.messageId}) tới ${c.to.join(", ")}.` };
    },
  };
  return [search, readThread, readMessage, labels, draft, send];
}
