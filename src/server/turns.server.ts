/**
 * W7 server-side turn manager for the desk chat. Sessions are keyed by turn id and live in the server
 * process, so a client can disconnect and resume the stream by turn id + seq. Per-thread strictly
 * serialized; a global cap (SABLE_CHAT_CONCURRENCY, default 3) shrinks while D7 heavy agents run
 * (never below 1). SABLE_CHAT_QUEUE=0 → the client falls back to the old one-shot /api/chat stream.
 * Every submitted/steered/queued message is an owner message (initiator user:owner:web); forks run
 * as background jobs (no auto-approve) and post their result back as a threaded reply.
 */
import fs from "node:fs";
import path from "node:path";
import { TurnManager, type HistoryMsg, type TurnMode, type UserMsg } from "@/lib/agent/turns/manager";
import { clipExcerpt, steerText, withReference } from "@/lib/agent/turns/reply";
import { clipHistory } from "@/lib/agent/assemble";
import type { ClientEvent } from "@/lib/agent/harness";
import type { ChatRequest } from "@/lib/agent/types";
import type { Job } from "@/lib/agent/jobs/types";
import { writeAtomic } from "@/lib/agent/jobs/db";
import { mcpWarm, prepareTurn, recallQuery, runTurnCore, turnError } from "@/server/chat.server";
import { recallBlockFor } from "@/server/vector.server";
import { heavySlots } from "@/server/desktop.server";
import { onJobEvents } from "@/server/channel-bus";
import { jobConfig, jobService } from "@/server/jobs.server";
import { dataDir } from "@/server/paths";

const TURN_MS = 240_000;
const KEY = Symbol.for("sable.turns.v1");

export function chatQueueOn() {
  return (process.env.SABLE_CHAT_QUEUE ?? "1").trim() !== "0";
}

export function chatCap() {
  const raw = Number(process.env.SABLE_CHAT_CONCURRENCY);
  return Number.isFinite(raw) && raw >= 1 ? Math.min(8, Math.round(raw)) : 3;
}

/** Effective cap: the chat cap minus heavy agents (D7) currently running, at least 1. */
export function effectiveCap() {
  let heavy = 0;
  try {
    heavy = heavySlots().active().length;
  } catch {
    heavy = 0;
  }
  return Math.max(1, chatCap() - heavy);
}

type Reply = { id: string; replyTo: string; content: string; status: "running" | "done" | "error" | "cancelled"; jobId?: string; createdAt: number; updatedAt: number; threaded: true };
type State = { manager: TurnManager<ChatRequest>; outbox: Map<string, Reply[]>; loaded: boolean };

function outboxFile() {
  return path.join(dataDir(), "turn-outbox.json");
}

function saveOutbox(s: State) {
  try {
    const entries = [...s.outbox.entries()].slice(-200).map(([k, v]) => [k, v.slice(-50)]);
    writeAtomic(outboxFile(), JSON.stringify({ v: 1, threads: Object.fromEntries(entries) }));
  } catch {
    /* in-memory copy still serves this process */
  }
}

function loadOutbox(): Map<string, Reply[]> {
  try {
    const raw = JSON.parse(fs.readFileSync(outboxFile(), "utf8")) as { threads?: Record<string, Reply[]> };
    return new Map(Object.entries(raw.threads ?? {}).filter(([, v]) => Array.isArray(v)));
  } catch {
    return new Map();
  }
}

function build(base: ChatRequest, history: HistoryMsg[], msgs: UserMsg[]): ChatRequest {
  const { messages } = clipHistory([...history, ...msgs.map((m) => ({ role: "user", content: m.content }))]);
  return { ...base, messages };
}

function state(): State {
  const g = globalThis as unknown as Record<symbol, State | undefined>;
  const existing = g[KEY];
  if (existing) return existing;
  const s: State = {
    manager: new TurnManager<ChatRequest>({
      cap: effectiveCap,
      build,
      run: async (h) => {
        let lastStatus = "";
        const emit = (piece: ClientEvent) => {
          if (piece.event === "delta") lastStatus = "";
          if (piece.event === "status") {
            if (piece.data.text === lastStatus) return;
            lastStatus = piece.data.text;
          }
          h.emit(piece.event, piece.data);
        };
        const signal = AbortSignal.any([h.signal, AbortSignal.timeout(TURN_MS)]);
        await mcpWarm();
        if (signal.aborted) throw new Error("stopped");
        const input = h.request;
        const recall = await recallBlockFor(recallQuery(input), input.threadId);
        const turn = prepareTurn(input, "", { mode: "interactive", source: "chat", sourceRef: input.threadId, mcp: true, recall });
        if (!turn) throw new Error("Mô hình chưa sẵn sàng trong môi trường này.");
        for (const text of turn.notices) emit({ event: "notice", data: { text } });
        const steered: HistoryMsg[] = [];
        try {
          const result = await runTurnCore({
            input,
            turn,
            transport: turn.transport,
            emit,
            signal,
            steer: () =>
              h.takeSteer().map((m) => {
                steered.push({ role: "user", content: m.content });
                return steerText(m.content);
              }),
            extraHistory: steered,
          });
          return { text: result.text };
        } catch (error) {
          if (h.signal.aborted) throw error;
          throw new Error(turnError(error, signal).slice(0, 240));
        }
      },
    }),
    outbox: loadOutbox(),
    loaded: true,
  };
  g[KEY] = s;
  // Re-check the cap when heavy agents finish (cheap poll; no-op while nobody waits).
  setInterval(() => s.manager.poke(), 2_000).unref?.();
  onJobEvents("desk-forks", {
    finish(job: Job) {
      if (job.origin?.channel !== "desk") return;
      const text = job.status === "done" ? job.text.trim() || "(Xong, không có nội dung.)" : job.status === "cancelled" ? "Việc song song đã bị huỷ." : `Việc song song lỗi: ${job.error ?? "không rõ"}`;
      upsertReply(s, job.origin.threadId, { id: `fork_${job.id}`, replyTo: job.origin.replyTo, content: text, status: job.status === "done" ? "done" : job.status === "cancelled" ? "cancelled" : "error", jobId: job.id });
    },
  });
  return s;
}

function upsertReply(s: State, threadId: string, r: Omit<Reply, "createdAt" | "updatedAt" | "threaded">) {
  const list = s.outbox.get(threadId) ?? [];
  const now = Date.now();
  const i = list.findIndex((x) => x.id === r.id);
  const next: Reply = { ...r, threaded: true, createdAt: i >= 0 ? list[i].createdAt : now, updatedAt: now };
  if (i >= 0) list[i] = next;
  else list.push(next);
  s.outbox.delete(threadId);
  s.outbox.set(threadId, list.slice(-50));
  saveOutbox(s);
}

export function turnManager() {
  return state().manager;
}

export type SubmitBody = { threadId: string; messageId: string; mode: TurnMode | "fork"; request: ChatRequest; quote?: { role?: string; excerpt?: string } | null; replyTo?: string };

/** Submit an owner message. `request.messages` = client history + this message (last). */
export function submitTurn(body: SubmitBody) {
  const s = state();
  const last = body.request.messages[body.request.messages.length - 1];
  const content = withReference(last.content, body.quote);
  if (body.mode === "fork") {
    const { runner } = jobService();
    if (!runner.enabled()) return { ok: false as const, status: 409, message: "Việc nền đang tắt trên máy chủ (SABLE_JOBS=0)." };
    const config = jobConfig();
    const request: ChatRequest = { ...body.request, messages: [...body.request.messages.slice(0, -1), { role: "user", content }] };
    // initiator defaults to user:owner:web; background mode → approvals always ask (never auto).
    const job = runner.enqueue({ title: `Song song: ${last.content.slice(0, 60)}`, request, maxSteps: config.maxSteps, timeoutMs: config.timeoutMs, origin: { channel: "desk", threadId: body.threadId, replyTo: body.messageId } });
    upsertReply(s, body.threadId, { id: `fork_${job.id}`, replyTo: body.messageId, content: "", status: "running", jobId: job.id });
    return { ok: true as const, disposition: "fork" as const, jobId: job.id, replyId: `fork_${job.id}` };
  }
  const message: UserMsg = { id: body.messageId, content, replyTo: body.replyTo, at: Date.now() };
  const request: ChatRequest = { ...body.request, threadId: body.threadId, messages: [...body.request.messages.slice(0, -1), { role: "user", content }] };
  const out = s.manager.submit({ threadId: body.threadId, message, mode: body.mode, request });
  return { ok: true as const, ...out };
}

export function threadView(threadId: string) {
  const s = state();
  return { enabled: chatQueueOn(), cap: effectiveCap(), stats: s.manager.stats(), ...s.manager.view(threadId), replies: s.outbox.get(threadId) ?? [] };
}

export function stopTurn(turnId: string) {
  return turnManager().stop(turnId);
}

export function cancelQueued(threadId: string, id: string) {
  const m = turnManager();
  return m.cancelQueued(threadId, id) || m.cancelSteer(threadId, id);
}

export { clipExcerpt };
