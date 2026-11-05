/**
 * Outside channels, owner only. Off unless configured; SABLE_CHANNELS=0 turns
 * them all off. Telegram: long-poll, allowlisted owner ids, approval buttons.
 * SMTP: notifications to the one configured address. The model never chooses a
 * recipient: replies go back to the chat that asked, mail to SABLE_SMTP_TO.
 */
import { recordIncoming } from "@/server/proactive.server";
import { decideAs } from "@/server/audit.server";
import fs from "node:fs";
import path from "node:path";
import { parseChatRequest } from "@/lib/agent/harness";
import { availableModels } from "@/lib/agent/provider";
import { parseOwners, TelegramChannel } from "@/lib/agent/channels/telegram";
import { SmtpChannel, smtpConfigFrom } from "@/lib/agent/channels/smtp";
import { WebhookChannel, webhookConfigFrom, makeEvent, MAX_TEXT } from "@/lib/agent/channels/webhook";
import { writeAtomic } from "@/lib/agent/jobs/db";
import { isActive, type Job, type JobApproval } from "@/lib/agent/jobs/types";
import { onJobEvents } from "@/server/channel-bus";
import { dataDir } from "@/server/paths";
import { jobConfig, jobService } from "@/server/jobs.server";
import { leftoverJobSteer, steerJob } from "@/server/job-steer";
import { withReference } from "@/lib/agent/turns/reply";
import type { TgReplyRef } from "@/lib/agent/channels/telegram";

/** W7: send the short "received" ack only when the turn is still running after this long. */
const ACK_MS = Number(process.env.SABLE_CHANNEL_ACK_MS) || 5_000;

const KEY = Symbol.for("sable.channels.v1");
const HISTORY = 8;
const RATE_WINDOW_MS = 10 * 60_000;

type State = {
  telegram: TelegramChannel | null;
  telegramError?: string;
  smtp: SmtpChannel | null;
  smtpError?: string;
  webhook: WebhookChannel | null;
  webhookError?: string;
  /** Recent exchange per Telegram chat (in memory only). */
  history: Map<number, { role: "user" | "assistant"; content: string }[]>;
  /** Webhook peer conversation history. */
  webhookHistory: Map<string, { role: "user" | "assistant"; content: string }[]>;
  /** approvalId → the Telegram message holding its buttons. */
  cards: Map<string, { chatId: number; messageId: number; summary: string }>;
  recent: number[];
  /** W7: owner messages waiting for the chat's current job to finish (queue mode / leftovers). */
  after: Map<string, { text: string; messageId?: number; replyTo?: string }[]>;
};

export function channelsOn() {
  return (process.env.SABLE_CHANNELS ?? "1").trim() !== "0";
}

function scope() {
  return globalThis as unknown as Record<symbol, State | undefined>;
}

function offsetFile() {
  return path.join(dataDir(), "telegram.json");
}

function readOffset() {
  try {
    const raw = JSON.parse(fs.readFileSync(offsetFile(), "utf8")) as { offset?: unknown };
    return typeof raw.offset === "number" && Number.isFinite(raw.offset) ? raw.offset : 0;
  } catch {
    return 0;
  }
}

function notifyMode(name: string, fallback: "own" | "all" | "off") {
  const raw = (process.env[name] ?? fallback).trim();
  return raw === "all" || raw === "off" || raw === "own" ? raw : fallback;
}

const STATE_LABEL: Record<string, string> = { approved: "Đã duyệt", rejected: "Đã từ chối", expired: "Hết hạn duyệt (coi như từ chối)" };

function resultText(job: Job) {
  if (job.status === "done") return job.text.trim() || "(Xong, không có nội dung.)";
  if (job.status === "cancelled") return "Việc đã bị huỷ.";
  return `Việc lỗi: ${job.error ?? "không rõ"}`;
}

function telegramRequest(text: string, history: { role: "user" | "assistant"; content: string }[]) {
  const model = process.env.SABLE_TELEGRAM_MODEL?.trim() || availableModels(process.env)[0];
  const tools = new Set((process.env.SABLE_TELEGRAM_TOOLS ?? "files,fetch").split(/[\s,]+/));
  return parseChatRequest({
    model,
    effort: "high",
    instructions: "",
    memory: "",
    messages: [...history, { role: "user", content: text }],
    tools: { web: tools.has("web"), x: tools.has("x"), code: false, image: false, files: tools.has("files"), fetch: tools.has("fetch") },
  });
}

function activeJob(match: (job: Job) => boolean) {
  return jobService().db.listJobs().find((job) => isActive(job.status) && match(job));
}

/** Reply text with the quoted (replied-to) Telegram message inlined as the referenced message. */
function quoted(text: string, ref?: TgReplyRef) {
  return ref?.text ? withReference(text, { role: ref.fromBot ? "assistant" : "user", excerpt: ref.text }) : text;
}

function ackLater(state: State, chatId: number, messageId: number, jobId: string, steered: boolean) {
  const timer = setTimeout(() => {
    const job = jobService().db.getJob?.(jobId);
    if (job && !isActive(job.status)) return;
    void state.telegram?.send(chatId, steered ? "Đã nhận ✓ — mình đưa vào việc đang làm." : "Đã nhận ✓ — đang làm.", undefined, messageId).catch(() => undefined);
  }, ACK_MS);
  timer.unref?.();
}

async function onTelegramMessage(state: State, msg: { chatId: number; text: string; messageId?: number; replyTo?: TgReplyRef }) {
  const tg = state.telegram!;
  const text = msg.text.trim();
  const history = state.history.get(msg.chatId) ?? [];
  if (/^\/(start|help)\b/.test(text)) {
    await tg.send(msg.chatId, "Sable đây. Gửi việc cần làm, mình chạy nền và trả lời ở đây. Ghi file sẽ hỏi duyệt bằng nút.\n/new — bắt đầu cuộc mới\n/status — việc đang chạy");
    return;
  }
  if (/^\/new\b/.test(text)) {
    state.history.delete(msg.chatId);
    await tg.send(msg.chatId, "Đã bắt đầu cuộc mới.");
    return;
  }
  const { db, runner } = jobService();
  if (/^\/status\b/.test(text)) {
    const mine = db.listJobs().filter((job) => job.origin?.channel === "telegram" && isActive(job.status));
    await tg.send(msg.chatId, mine.length ? mine.map((job) => `• ${job.title} — ${job.status}`).join("\n") : "Không có việc nào đang chạy.");
    return;
  }
  const now = Date.now();
  state.recent = state.recent.filter((at) => now - at < RATE_WINDOW_MS);
  const limit = Number(process.env.SABLE_TELEGRAM_RATE) || 20;
  if (state.recent.length >= limit) {
    await tg.send(msg.chatId, "Nhiều việc quá trong 10 phút. Đợi chút rồi gửi lại.");
    return;
  }
  if (!runner.enabled()) {
    await tg.send(msg.chatId, "Việc nền đang tắt trên máy chủ.");
    return;
  }
  const content = quoted(text, msg.replyTo);
  state.recent.push(now);
  recordIncoming({ id: `tg_${msg.chatId}_${now.toString(36)}`, source: "telegram", from: `telegram:${msg.chatId}`, title: "Telegram from you", body: text.slice(0, 2_000), at: now, meta: { kind: "message", fromOwner: true } });
  // W7: the chat already has a job running → steer this message into it (next safe point).
  const running = activeJob((job) => job.origin?.channel === "telegram" && job.origin.chatId === msg.chatId);
  if (running) {
    if (steerJob(running.id, content)) {
      state.history.set(msg.chatId, [...history, { role: "user" as const, content }].slice(-HISTORY));
      if (msg.messageId) ackLater(state, msg.chatId, msg.messageId, running.id, true);
      return;
    }
    const list = state.after.get(`tg:${msg.chatId}`) ?? [];
    state.after.set(`tg:${msg.chatId}`, [...list, { text: content, messageId: msg.messageId }].slice(-20));
    return;
  }
  const job = startTelegramJob(state, msg.chatId, content, msg.messageId);
  if (typeof job === "string") {
    await tg.send(msg.chatId, `Không chạy được: ${job}`);
    return;
  }
  if (msg.messageId) ackLater(state, msg.chatId, msg.messageId, job.id, false);
}

function startTelegramJob(state: State, chatId: number, content: string, messageId?: number): Job | string {
  const history = state.history.get(chatId) ?? [];
  const parsed = telegramRequest(content, history);
  if (!parsed.ok) return parsed.error;
  const config = jobConfig();
  const job = jobService().runner.enqueue({
    title: `Telegram: ${content.replace(/^\[Referenced message[^\]]*\]\s*/, "").slice(0, 60)}`,
    request: parsed.request,
    maxSteps: config.maxSteps,
    timeoutMs: config.timeoutMs,
    origin: { channel: "telegram", chatId, ...(messageId ? { messageId } : {}) },
  });
  state.history.set(chatId, [...history, { role: "user" as const, content }].slice(-HISTORY));
  return job;
}

/** After a channel job ends: undelivered steer messages + queued ones become the next job. */
function runAfter(state: State, job: Job) {
  const origin = job.origin;
  if (!origin || origin.channel === "desk") return;
  const leftovers = leftoverJobSteer(job.id);
  const key = origin.channel === "telegram" ? `tg:${origin.chatId}` : `wh:${origin.peerId}`;
  const queued = state.after.get(key) ?? [];
  state.after.delete(key);
  const items = [...leftovers.map((text) => ({ text, messageId: undefined as number | undefined, replyTo: undefined as string | undefined })), ...queued];
  if (!items.length || !jobService().runner.enabled()) return;
  const text = items.map((i) => i.text).join("\n\n");
  const last = [...items].reverse().find((i) => i.messageId || i.replyTo);
  if (origin.channel === "telegram") startTelegramJob(state, origin.chatId, text, last?.messageId);
  else startWebhookJob(state, origin.peerId, text, last?.replyTo);
}

async function onTelegramCallback(state: State, cb: { chatId: number; data: string }) {
  const match = /^(a|r):([A-Za-z0-9-]{8,60})$/.exec(cb.data);
  if (!match) return "Nút không hợp lệ.";
  const card = state.cards.get(match[2]);
  // Only the chat the card was sent to may answer it.
  if (!card || card.chatId !== cb.chatId) return "Yêu cầu này không còn chờ duyệt.";
  // Owner on an allow-listed Telegram chat = a human channel decider (W2a policy + audit).
  const out = decideAs(match[2], match[1] === "a", { kind: "channel", id: `telegram:${cb.chatId}` }, { jobsOnly: true });
  if (!out.ok) return out.status === 403 ? "Không được duyệt từ đây." : "Yêu cầu này không còn chờ duyệt.";
  return match[1] === "a" ? "Đã duyệt" : "Đã từ chối";
}


function wantsWebhook(job: Job) {
  const mode = notifyMode("SABLE_WEBHOOK_NOTIFY", "own");
  if (mode === "off") return job.origin?.channel === "webhook";
  return job.origin?.channel === "webhook" || mode === "all";
}

function webhookTarget(job: Job) {
  if (job.origin?.channel === "webhook") return job.origin.peerId;
  return process.env.SABLE_WEBHOOK_OWNER?.trim() || "owner";
}

function wantsTelegram(job: Job) {
  const mode = notifyMode("SABLE_TELEGRAM_NOTIFY", "own");
  if (mode === "off") return job.origin?.channel === "telegram";
  return job.origin?.channel === "telegram" || mode === "all";
}

function telegramTarget(job: Job) {
  if (job.origin?.channel === "telegram") return job.origin.chatId;
  const owners = parseOwners(process.env.SABLE_TELEGRAM_OWNER_IDS);
  return [...owners][0];
}

function wire(state: State) {
  onJobEvents("channels", {
    finish(job) {
      const wh = state.webhook;
      if (wh && wantsWebhook(job)) {
        const peerId = webhookTarget(job);
        if (peerId) {
          const text = job.origin?.channel === "webhook" ? resultText(job) : `${job.title}\n\n${resultText(job)}`;
          const replyTo = job.origin?.channel === "webhook" ? job.origin.replyTo : undefined;
          void wh.deliver(makeEvent("job.result", { text: text.slice(0, MAX_TEXT), status: job.status, title: job.title, ...(replyTo ? { reply_to: replyTo } : {}) }, { peerId, ref: { jobId: job.id, routineId: job.routineId } }));
          if (job.origin?.channel === "webhook" && job.status === "done" && job.text.trim()) {
            const history = state.webhookHistory.get(peerId) ?? [];
            state.webhookHistory.set(peerId, [...history, { role: "assistant" as const, content: job.text.slice(0, 4_000) }].slice(-HISTORY));
          }
        }
      }
            const tg = state.telegram;
      if (tg && wantsTelegram(job)) {
        const chatId = telegramTarget(job);
        if (chatId !== undefined) {
          const body = job.origin ? resultText(job) : `${job.title}\n\n${resultText(job)}`;
          const replyTo = job.origin?.channel === "telegram" ? job.origin.messageId : undefined;
          void tg.send(chatId, body, undefined, replyTo).catch(() => undefined);
          if (job.origin?.channel === "telegram" && job.status === "done" && job.text.trim()) {
            const history = state.history.get(chatId) ?? [];
            state.history.set(chatId, [...history, { role: "assistant" as const, content: job.text.slice(0, 4_000) }].slice(-HISTORY));
          }
        }
      }
      try {
        runAfter(state, job);
      } catch (error) {
        console.warn(`[sable-channels] follow-up failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      const smtp = state.smtp;
      const mailMode = notifyMode("SABLE_SMTP_NOTIFY", "own");
      if (smtp && mailMode !== "off" && (job.kind === "routine" || mailMode === "all")) {
        const verdict = job.status === "done" ? "xong" : job.status === "cancelled" ? "đã huỷ" : "lỗi";
        void smtp.notify({ subject: `Sable: ${job.title} — ${verdict}`, text: `${resultText(job)}\n\n— Sable (việc ${job.id})` });
      }
    },
    waiting(job, approval) {
      const wh = state.webhook;
      if (wh && wantsWebhook(job)) {
        const peerId = webhookTarget(job);
        if (peerId) {
          void wh.send({
            peerId,
            text: `Cần duyệt: ${approval.summary}\n(${job.title})`,
            approvals: [{ id: approval.id, summary: approval.summary, preview: approval.preview }],
          });
        }
      }
      const tg = state.telegram;
      if (tg && wantsTelegram(job)) {
        const chatId = telegramTarget(job);
        if (chatId !== undefined) {
          const summary = `Cần duyệt: ${approval.summary}\n(${job.title})${approval.preview ? `\n\n${approval.preview.slice(0, 1_500)}` : ""}`;
          void tg
            .send(chatId, summary, [[{ text: "✅ Duyệt", data: `a:${approval.id}` }, { text: "❌ Từ chối", data: `r:${approval.id}` }]])
            .then((sent) => {
              state.cards.set(approval.id, { chatId, messageId: sent.message_id, summary: `Cần duyệt: ${approval.summary}` });
            })
            .catch(() => undefined);
        }
      }
      const smtp = state.smtp;
      if (smtp && notifyMode("SABLE_SMTP_NOTIFY", "own") !== "off" && (job.kind === "routine" || notifyMode("SABLE_SMTP_NOTIFY", "own") === "all")) {
        void smtp.notify({ subject: `Sable: cần duyệt — ${job.title}`, text: `${approval.summary}\n\nMở Sable (Hộp thư) để duyệt hoặc từ chối. Không trả lời thư này.` });
      }
    },
    settled(_job, approval) {
      const card = state.cards.get(approval.id);
      if (!card) return;
      state.cards.delete(approval.id);
      void state.telegram?.edit(card.chatId, card.messageId, `${card.summary}\n→ ${STATE_LABEL[approval.state] ?? approval.state}`).catch(() => undefined);
    },
  });
}

/** Start configured channels once per process. Safe to call repeatedly. */
export function startChannels(): State {
  const existing = scope()[KEY];
  if (existing) return existing;
  const state: State = { telegram: null, smtp: null, webhook: null, history: new Map(), webhookHistory: new Map(), cards: new Map(), recent: [], after: new Map() };
  scope()[KEY] = state;
  if (!channelsOn()) return state;
  if (jobService().foreignOwner !== null) return state;

  const token = process.env.SABLE_TELEGRAM_TOKEN?.trim();
  if (token) {
    const owners = parseOwners(process.env.SABLE_TELEGRAM_OWNER_IDS);
    if (!owners.size) state.telegramError = "Thiếu SABLE_TELEGRAM_OWNER_IDS (id Telegram của bạn) nên Telegram không bật.";
    else {
      state.telegram = new TelegramChannel({
        token,
        base: process.env.SABLE_TELEGRAM_API_BASE?.trim() || undefined,
        owners,
        offset: readOffset(),
        saveOffset: (offset) => {
          try {
            writeAtomic(offsetFile(), JSON.stringify({ offset }));
          } catch {
            /* replay at worst */
          }
        },
        pollSeconds: Number(process.env.SABLE_TELEGRAM_POLL_SEC) || 25,
        onMessage: (msg) => onTelegramMessage(state, msg),
        onCallback: (cb) => onTelegramCallback(state, cb),
        log: (line) => console.warn(`[sable-telegram] ${line}`),
      });
      state.telegram.start();
      console.log(`[sable-telegram] polling for ${owners.size} owner id(s)`);
    }
  }
  const smtp = smtpConfigFrom(process.env);
  if (smtp.config) state.smtp = new SmtpChannel(smtp.config);
  else if (smtp.error) state.smtpError = smtp.error;

  const wh = webhookConfigFrom(process.env);
  if (wh.error) state.webhookError = wh.error;
  else if (wh.config) {
    state.webhook = new WebhookChannel({
      ...wh.config,
      onInbound: (event) => onWebhookInbound(state, event),
    });
    console.log(`[sable-webhook] inbound ready (outbound ${wh.config.outboundUrl ? "on" : "off"})`);
  }
  wire(state);
  return state;
}

function maskEmail(address: string) {
  const [user, host] = address.split("@");
  return `${user.slice(0, 2)}***@${host}`;
}

export function channelStatus() {
  jobService();
  const state = startChannels();
  return {
    enabled: channelsOn(),
    telegram: {
      configured: Boolean(process.env.SABLE_TELEGRAM_TOKEN?.trim()),
      running: Boolean(state.telegram?.running()),
      owners: parseOwners(process.env.SABLE_TELEGRAM_OWNER_IDS).size,
      handled: state.telegram?.handled ?? 0,
      dropped: state.telegram?.dropped ?? 0,
      error: state.telegramError ?? (state.telegram?.lastError || undefined),
    },
    smtp: {
      configured: Boolean(state.smtp),
      to: state.smtp ? maskEmail(state.smtp.to) : undefined,
      sent: state.smtp?.sent ?? 0,
      error: state.smtpError ?? (state.smtp?.lastError || undefined),
    },
    webhook: {
      configured: Boolean(state.webhook),
      outbound: Boolean(state.webhook?.config.outboundUrl),
      owner: state.webhook?.config.ownerPeerId,
      sent: state.webhook?.sent ?? 0,
      received: state.webhook?.received ?? 0,
      error: state.webhookError ?? (state.webhook?.lastError || undefined),
    },
  };
}

/** Test hook: stop pollers and forget state (used by the e2e cleanup). */
export async function stopChannels() {
  const state = scope()[KEY];
  scope()[KEY] = undefined;
  await state?.telegram?.stop();
  state?.smtp?.close();
  // webhook is stateless HTTP — nothing to stop
}


async function onWebhookInbound(state: State, event: import("@/lib/agent/channels/webhook").WebhookEvent) {
  if (event.type === "approval.response") {
    const id = typeof event.payload.approvalId === "string" ? event.payload.approvalId : event.ref?.approvalId;
    const decide = event.payload.approve === true || event.payload.decision === "approve";
    if (!id) return makeEvent("pong", { ok: false, error: "missing approvalId" }, { peerId: event.peerId });
    // A webhook peer is a channel decider; it may not approve a run its own message started (W2a).
    const out = decideAs(id, Boolean(decide), { kind: "channel", id: `webhook:${event.peerId ?? ""}` }, { jobsOnly: true });
    return makeEvent("pong", { ok: out.ok, decision: decide ? "approve" : "reject", ...(out.ok ? {} : { error: out.reason }) }, { peerId: event.peerId, ref: { approvalId: id } });
  }
  if (event.type !== "message.in") return;
  const text = typeof event.payload.text === "string" ? event.payload.text.trim() : "";
  if (!text) return makeEvent("pong", { ok: false, error: "empty text" }, { peerId: event.peerId });
  const peerId = event.peerId!;
  const now = Date.now();
  state.recent = state.recent.filter((at) => now - at < RATE_WINDOW_MS);
  const limit = Number(process.env.SABLE_WEBHOOK_RATE) || 30;
  if (state.recent.length >= limit) {
    return makeEvent("message.out", { text: "Bạn đang gửi quá nhanh, chờ một chút rồi thử lại." }, { peerId });
  }
  if (!jobService().runner.enabled()) return makeEvent("message.out", { text: "Việc nền đang tắt trên máy chủ." }, { peerId });
  // W7: optional reply_to (id the app uses for threading; echoed on job.result) + reply_text (quoted excerpt) + mode.
  const replyTo = typeof event.payload.reply_to === "string" && /^[A-Za-z0-9_.:-]{1,120}$/.test(event.payload.reply_to) ? event.payload.reply_to : event.id;
  const replyText = typeof event.payload.reply_text === "string" ? event.payload.reply_text.slice(0, 4_000) : "";
  const mode = event.payload.mode === "queue" ? "queue" : event.payload.mode === "new" ? "new" : "steer";
  const content = replyText ? withReference(text.slice(0, 8_000), { role: event.payload.reply_role === "assistant" ? "assistant" : "user", excerpt: replyText }) : text.slice(0, 8_000);
  state.recent.push(now);
  const ownerPeer = state.webhook?.config.ownerPeerId;
  recordIncoming({ id: `wh_${event.id}`.slice(0, 100), source: "webhook", from: `webhook:${peerId}`, title: typeof event.payload.title === "string" ? event.payload.title.slice(0, 200) : `Webhook from ${peerId}`, body: text.slice(0, 2_000), at: now, meta: { kind: "event", fromOwner: Boolean(ownerPeer && ownerPeer === peerId) } });
  const running = mode === "new" ? undefined : activeJob((job) => job.origin?.channel === "webhook" && job.origin.peerId === peerId);
  if (running && mode === "steer" && steerJob(running.id, content)) {
    const history = state.webhookHistory.get(peerId) ?? [];
    state.webhookHistory.set(peerId, [...history, { role: "user" as const, content }].slice(-HISTORY));
    return makeEvent("pong", { ok: true, jobId: running.id, mode: "steered" }, { peerId, ref: { jobId: running.id } });
  }
  if (running) {
    const list = state.after.get(`wh:${peerId}`) ?? [];
    state.after.set(`wh:${peerId}`, [...list, { text: content, replyTo }].slice(-20));
    return makeEvent("pong", { ok: true, jobId: running.id, mode: "queued" }, { peerId, ref: { jobId: running.id } });
  }
  const job = startWebhookJob(state, peerId, content, replyTo);
  if (typeof job === "string") return makeEvent("message.out", { text: job }, { peerId });
  return makeEvent("pong", { ok: true, jobId: job.id, mode: "started" }, { peerId, ref: { jobId: job.id } });
}

function startWebhookJob(state: State, peerId: string, content: string, replyTo?: string): Job | string {
  const history = state.webhookHistory.get(peerId) ?? [];
  const parsed = telegramRequest(content, history);
  if (!parsed.ok) return parsed.error;
  const config = jobConfig();
  const job = jobService().runner.enqueue({
    title: `Webhook: ${content.replace(/^\[Referenced message[^\]]*\]\s*/, "").slice(0, 60)}`,
    request: parsed.request,
    maxSteps: config.maxSteps,
    timeoutMs: config.timeoutMs,
    origin: { channel: "webhook", peerId, ...(replyTo ? { replyTo } : {}) },
  });
  state.webhookHistory.set(peerId, [...history, { role: "user" as const, content }].slice(-HISTORY));
  return job;
}

/**
 * Send a Sable-composed note (the morning brief) to the owner's own Telegram
 * chat. Fixed recipient (first SABLE_TELEGRAM_OWNER_IDS id); the model never
 * picks it. Returns false when Telegram is not configured.
 */
export async function notifyOwnerTelegram(text: string): Promise<boolean> {
  const state = startChannels();
  const tg = state.telegram;
  const chatId = [...parseOwners(process.env.SABLE_TELEGRAM_OWNER_IDS)][0];
  if (!tg || chatId === undefined) return false;
  try {
    await tg.send(chatId, text.slice(0, 3_900));
    return true;
  } catch {
    return false;
  }
}

export function getWebhookChannel() {
  return startChannels().webhook;
}

export type { JobApproval };
