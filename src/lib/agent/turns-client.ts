/**
 * W7 desk client for the server turn manager (/api/turns). The server owns the turn; the browser
 * only submits owner messages and follows (or resumes) a turn's event stream by id + seq.
 */
import { parseBlock, readError, withPrefix, type StreamHandlers } from "./client.ts";
import type { ChatRequest } from "./types.ts";

export type SendMode = "auto" | "steer" | "queue" | "interrupt" | "fork";
export type SubmitOut = { ok: true; disposition: "started" | "waiting" | "steered" | "coalesced" | "queued" | "interrupted" | "fork"; turnId?: string; queueId?: string; jobId?: string; replyId?: string; notices?: string[] };
export type TurnBrief = { id: string; status: string; seq: number; messageIds: string[]; steeredIds: string[]; restarts: number; error?: string };
export type ThreadedReply = { id: string; replyTo: string; content: string; status: "running" | "done" | "error" | "cancelled"; jobId?: string; createdAt: number; updatedAt: number };
export type TurnsView = {
  enabled: boolean;
  cap?: number;
  running: TurnBrief | null;
  queue: { id: string; createdAt: number; messages: { id: string; preview: string }[] }[];
  steerPending: { id: string; preview: string }[];
  recent: TurnBrief[];
  replies: ThreadedReply[];
};

async function post(body: unknown) {
  const res = await fetch(withPrefix("/api/turns"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await readError(res, "Không gửi được."));
  return res.json();
}

export function submitTurn(p: { threadId: string; messageId: string; mode: SendMode; request: ChatRequest; replyTo?: string }): Promise<SubmitOut> {
  return post({ action: "submit", ...p });
}

export function stopTurn(turnId: string): Promise<{ ok: boolean }> {
  return post({ action: "stop", turnId });
}

export function cancelQueued(threadId: string, id: string): Promise<{ ok: boolean }> {
  return post({ action: "cancel", threadId, id });
}

export async function turnsView(threadId: string, signal?: AbortSignal): Promise<TurnsView> {
  const res = await fetch(withPrefix(`/api/turns?thread=${encodeURIComponent(threadId)}`), { signal, cache: "no-store" });
  if (!res.ok) throw new Error(await readError(res, "Không đọc được hàng đợi."));
  const view = (await res.json()) as Partial<TurnsView>;
  return { enabled: view.enabled !== false, cap: view.cap, running: view.running ?? null, queue: view.queue ?? [], steerPending: view.steerPending ?? [], recent: view.recent ?? [], replies: view.replies ?? [] };
}

export type FollowHandlers = StreamHandlers & {
  onReset: () => void;
  onSteered: (ids: string[]) => void;
  onSeq: (seq: number) => void;
};

/**
 * Follow a turn from `after`. Resolves with the final status ("done" | "stopped" | "error" | …);
 * throws only on transport problems (the caller may resume with the last seq).
 */
export async function followTurn(turnId: string, after: number, h: FollowHandlers): Promise<{ status: string; error?: string }> {
  const res = await fetch(withPrefix(`/api/turns/stream?turn=${encodeURIComponent(turnId)}&after=${after}`), { signal: h.signal, cache: "no-store" });
  if (res.status === 404) return { status: "gone" };
  if (!res.ok || !res.body) throw new Error(await readError(res, "Mất kết nối lượt chạy."));
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let carry = "";
  let final: { status: string; error?: string } | null = null;
  let error: string | undefined;
  const take = (block: string) => {
    if (!block.trim()) return;
    let event = "message";
    let seq = -1;
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("id:")) seq = Number(line.slice(3).trim());
      else if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (seq >= 0) h.onSeq(seq);
    let payload: Record<string, unknown> = {};
    try {
      payload = data ? (JSON.parse(data) as Record<string, unknown>) : {};
    } catch {
      return;
    }
    if (event === "end") final = { status: typeof payload.status === "string" ? payload.status : "done", error };
    else if (event === "reset") h.onReset();
    else if (event === "steered" && Array.isArray(payload.ids)) h.onSteered(payload.ids.filter((x): x is string => typeof x === "string"));
    else if (event === "error") error = typeof payload.message === "string" ? payload.message : "Mô hình dừng giữa chừng.";
    else if (event === "done" || event === "stopped" || event === "turn" || event === "status_turn" || event === "steer_queued") return;
    else parseBlock(block, h);
  };
  while (!final) {
    const { done, value } = await reader.read();
    if (done) break;
    carry += decoder.decode(value, { stream: true });
    const blocks = carry.split("\n\n");
    carry = blocks.pop() ?? "";
    for (const block of blocks) take(block);
  }
  take(carry);
  reader.cancel().catch(() => undefined);
  if (!final) throw new Error("stream closed");
  return final;
}
