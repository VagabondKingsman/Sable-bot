/**
 * Outside channels, owner only. Off unless configured; SABLE_CHANNELS=0 turns
 * them all off. Telegram: long-poll, allowlisted owner ids, approval buttons.
 * SMTP: notifications to the one configured address. The model never chooses a
 * recipient: replies go back to the chat that asked, mail to SABLE_SMTP_TO.
 */
import fs from "node:fs";
import path from "node:path";
import { parseChatRequest } from "@/lib/agent/harness";
import { availableModels } from "@/lib/agent/provider";
import { parseOwners, TelegramChannel } from "@/lib/agent/channels/telegram";
import { SmtpChannel, smtpConfigFrom } from "@/lib/agent/channels/smtp";
import { writeAtomic } from "@/lib/agent/jobs/db";
import { isActive, type Job, type JobApproval } from "@/lib/agent/jobs/types";
import { onJobEvents } from "@/server/channel-bus";
import { dataDir } from "@/server/paths";
import { jobConfig, jobService } from "@/server/jobs.server";

const KEY = Symbol.for("sable.channels.v1");
const HISTORY = 8;
const RATE_WINDOW_MS = 10 * 60_000;

type State = {
  telegram: TelegramChannel | null;
  telegramError?: string;
  smtp: SmtpChannel | null;
  smtpError?: string;
  /** Recent exchange per Telegram chat (in memory only). */
  history: Map<number, { role: "user" | "assistant"; content: string }[]>;
  /** approvalId → the Telegram message holding its buttons. */
  cards: Map<string, { chatId: number; messageId: number; summary: string }>;
  recent: number[];
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

async function onTelegramMessage(state: State, msg: { chatId: number; text: string }) {
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
  const parsed = telegramRequest(text, history);
  if (!parsed.ok) {
    await tg.send(msg.chatId, `Không chạy được: ${parsed.error}`);
    return;
  }
  state.recent.push(now);
  const config = jobConfig();
  runner.enqueue({
    title: `Telegram: ${text.slice(0, 60)}`,
    request: parsed.request,
    maxSteps: config.maxSteps,
    timeoutMs: config.timeoutMs,
    origin: { channel: "telegram", chatId: msg.chatId },
  });
  state.history.set(msg.chatId, [...history, { role: "user" as const, content: text }].slice(-HISTORY));
  await tg.send(msg.chatId, "Đang làm…");
}

async function onTelegramCallback(state: State, cb: { chatId: number; data: string }) {
  const match = /^(a|r):([A-Za-z0-9-]{8,60})$/.exec(cb.data);
  if (!match) return "Nút không hợp lệ.";
  const card = state.cards.get(match[2]);
  // Only the chat the card was sent to may answer it.
  if (!card || card.chatId !== cb.chatId) return "Yêu cầu này không còn chờ duyệt.";
  const ok = jobService().runner.decide(match[2], match[1] === "a");
  if (!ok) return "Yêu cầu này không còn chờ duyệt.";
  return match[1] === "a" ? "Đã duyệt" : "Đã từ chối";
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
      const tg = state.telegram;
      if (tg && wantsTelegram(job)) {
        const chatId = telegramTarget(job);
        if (chatId !== undefined) {
          const body = job.origin ? resultText(job) : `${job.title}\n\n${resultText(job)}`;
          void tg.send(chatId, body).catch(() => undefined);
          if (job.origin?.channel === "telegram" && job.status === "done" && job.text.trim()) {
            const history = state.history.get(chatId) ?? [];
            state.history.set(chatId, [...history, { role: "assistant" as const, content: job.text.slice(0, 4_000) }].slice(-HISTORY));
          }
        }
      }
      const smtp = state.smtp;
      const mailMode = notifyMode("SABLE_SMTP_NOTIFY", "own");
      if (smtp && mailMode !== "off" && (job.kind === "routine" || mailMode === "all")) {
        const verdict = job.status === "done" ? "xong" : job.status === "cancelled" ? "đã huỷ" : "lỗi";
        void smtp.notify({ subject: `Sable: ${job.title} — ${verdict}`, text: `${resultText(job)}\n\n— Sable (việc ${job.id})` });
      }
    },
    waiting(job, approval) {
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
  const state: State = { telegram: null, smtp: null, history: new Map(), cards: new Map(), recent: [] };
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
  };
}

/** Test hook: stop pollers and forget state (used by the e2e cleanup). */
export async function stopChannels() {
  const state = scope()[KEY];
  scope()[KEY] = undefined;
  await state?.telegram?.stop();
  state?.smtp?.close();
}

export type { JobApproval };
