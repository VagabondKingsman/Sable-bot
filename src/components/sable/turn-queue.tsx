/**
 * W7 non-blocking composer support: the desk keeps the composer live while a turn runs.
 * Default send = steer into the running turn (server delivers it at the next safe point); the Send
 * menu offers queue / run in parallel (fork → threaded reply) / stop & send. The server turn
 * manager owns every turn, so a reload or network drop resumes the stream by turn id + seq.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, CornerDownRight, GitFork, ListPlus, MessageSquareReply, Square, X } from "lucide-react";
import { newMessageId, useAgent } from "@/lib/agent/store";
import type { ChatMessage, ChatRequest } from "@/lib/agent/types";
import { cancelQueued, followTurn, stopTurn, submitTurn, turnsView, type SendMode, type TurnsView } from "@/lib/agent/turns-client";

const POLL_MS = 1_500;
export const REF_PREVIEW = 600;

export type Quote = { id: string; role: "user" | "assistant"; excerpt: string };

/** Thread history for the server: main-flow messages only; quotes carried as `replyTo` refs. */
export function historyFor(messages: ChatMessage[]) {
  const byId = new Map(messages.map((m) => [m.id, m]));
  return messages
    .filter((m) => !m.threaded && m.content.trim())
    .map((m) => {
      const ref = m.replyTo ? byId.get(m.replyTo) : undefined;
      return ref ? { role: m.role, content: m.content, replyTo: { role: ref.role, excerpt: ref.content.slice(0, REF_PREVIEW * 2) } } : { role: m.role, content: m.content };
    });
}

type Follow = { threadId: string; assistantId: string; seq: number; ctl: AbortController };

export function useTurns(opts: { buildRequest: (threadId: string) => ChatRequest | null; activeId: string | null; hydrated: boolean; onError: (text: string) => void }) {
  const [queueOn, setQueueOn] = useState<boolean | null>(null);
  const [views, setViews] = useState<Record<string, TurnsView>>({});
  const follows = useRef(new Map<string, Follow>());
  const timers = useRef(new Map<string, number>());
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const store = () => useAgent.getState();

  const assistantFor = (threadId: string, turnId: string) => store().threads.find((t) => t.id === threadId)?.messages.find((m) => m.turnId === turnId && m.role === "assistant");

  const follow = useCallback(async (threadId: string, turnId: string, assistantId: string) => {
    if (follows.current.has(turnId)) return;
    const f: Follow = { threadId, assistantId, seq: 0, ctl: new AbortController() };
    follows.current.set(turnId, f);
    const s = store();
    let final: { status: string; error?: string } = { status: "gone" };
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        final = await followTurn(turnId, f.seq, {
          signal: f.ctl.signal,
          onSeq: (seq) => (f.seq = seq),
          onReset: () => s.resetMessage(threadId, assistantId),
          onSteered: (ids) => {
            for (const id of ids) s.patchMessage(threadId, id, { delivery: "steered" });
            s.moveToEnd(threadId, assistantId);
          },
          onDelta: (t) => s.appendDelta(threadId, assistantId, t),
          onStatus: (t) => s.setStatus(threadId, assistantId, t),
          onNotice: (t) => s.addNotice(threadId, assistantId, t),
          onStep: (step) => s.addStep(threadId, assistantId, step),
          onThought: (t) => s.appendThought(threadId, assistantId, t),
          onCitation: (u) => s.addCitation(threadId, assistantId, u),
          onImage: (src) => s.setMedia(threadId, assistantId, { type: "image", src }),
          onApproval: (a) => s.setApproval(threadId, assistantId, a),
        });
        break;
      } catch {
        if (f.ctl.signal.aborted) break;
        // Network drop / server restart: resume from the last seq.
        await new Promise((r) => setTimeout(r, Math.min(5_000, 500 * (attempt + 1))));
      }
    }
    follows.current.delete(turnId);
    const msg = assistantFor(threadId, turnId);
    if (final.status === "error") s.finishTurn(threadId, assistantId, final.error ?? "Không gửi được.");
    else if (final.status === "gone") s.finishTurn(threadId, assistantId, msg?.content ? undefined : "Lượt này không còn trên máy chủ (đã khởi động lại?).");
    else if (final.status === "done" && msg && !msg.content && !msg.media && !msg.steps?.length) s.finishTurn(threadId, assistantId, "Không có câu trả lời.");
    else s.finishTurn(threadId, assistantId);
    void refresh(threadId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ensureFollow = useCallback(
    (threadId: string, turnId: string, status: string) => {
      if (follows.current.has(turnId)) return;
      const s = store();
      let msg = assistantFor(threadId, turnId);
      if (!msg) {
        msg = { id: newMessageId(), role: "assistant", content: "", status: status === "waiting" ? "Đang chờ lượt" : "Đang viết", startedAt: Date.now(), turnId };
        s.addMessage(threadId, msg);
      } else s.resetMessage(threadId, msg.id); // replay from seq 0 after a reload
      void follow(threadId, turnId, msg.id);
    },
    [follow],
  );

  const refresh = useCallback(
    async (threadId: string) => {
      window.clearTimeout(timers.current.get(threadId));
      let view: TurnsView;
      try {
        view = await turnsView(threadId);
      } catch {
        timers.current.set(threadId, window.setTimeout(() => void refresh(threadId), POLL_MS * 4));
        return;
      }
      setQueueOn(view.enabled);
      if (!view.enabled) return;
      setViews((v) => ({ ...v, [threadId]: view }));
      const s = store();
      const thread = s.threads.find((t) => t.id === threadId);
      if (!thread) return;
      if (view.running && (view.running.status === "running" || view.running.status === "waiting")) ensureFollow(threadId, view.running.id, view.running.status);
      for (const r of view.replies) {
        const existing = thread.messages.find((m) => m.id === r.id);
        const status = r.status === "running" ? "Đang chạy song song" : undefined;
        if (!existing || existing.content !== r.content || existing.status !== status)
          s.upsertMessage(threadId, { id: r.id, role: "assistant", content: r.content, status, replyTo: r.replyTo, threaded: true, startedAt: r.createdAt, finishedAt: r.status === "running" ? undefined : r.updatedAt });
      }
      const pending = view.running || view.queue.length || view.steerPending.length || view.replies.some((r) => r.status === "running");
      if (pending) timers.current.set(threadId, window.setTimeout(() => void refresh(threadId), POLL_MS));
    },
    [ensureFollow],
  );

  // Hydrate / thread switch: discover a running turn (resume after reload) + threaded replies.
  useEffect(() => {
    if (!opts.hydrated || !opts.activeId) return;
    void refresh(opts.activeId);
  }, [opts.hydrated, opts.activeId, refresh]);

  useEffect(() => {
    const t = timers.current;
    const f = follows.current;
    return () => {
      for (const id of t.values()) window.clearTimeout(id);
      for (const x of f.values()) x.ctl.abort();
    };
  }, []);

  const send = useCallback(
    async (threadId: string, content: string, mode: SendMode, replyTo?: string) => {
      const s = store();
      const messageId = newMessageId();
      s.addMessage(threadId, { id: messageId, role: "user", content, ...(replyTo ? { replyTo } : {}), ...(mode === "fork" ? { delivery: "fork" as const } : {}) });
      const request = optsRef.current.buildRequest(threadId);
      if (!request) return;
      try {
        const out = await submitTurn({ threadId, messageId, mode, request, replyTo });
        if (out.disposition === "started" || out.disposition === "waiting" || out.disposition === "interrupted") {
          const assistantId = newMessageId();
          s.addMessage(threadId, { id: assistantId, role: "assistant", content: "", status: out.disposition === "waiting" ? "Đang chờ lượt" : "Đang viết", startedAt: Date.now(), turnId: out.turnId });
          void follow(threadId, out.turnId!, assistantId);
        } else if (out.disposition === "coalesced" || out.disposition === "steered") {
          const a = out.turnId ? assistantFor(threadId, out.turnId) : undefined;
          if (out.disposition === "steered") s.patchMessage(threadId, messageId, { delivery: "steered" });
          if (a) s.moveToEnd(threadId, a.id);
        } else if (out.disposition === "queued") s.patchMessage(threadId, messageId, { delivery: "queued" });
        else if (out.disposition === "fork" && out.replyId) s.upsertMessage(threadId, { id: out.replyId, role: "assistant", content: "", status: "Đang chạy song song", replyTo: messageId, threaded: true, startedAt: Date.now() });
        void refresh(threadId);
      } catch (error) {
        s.patchMessage(threadId, messageId, { notice: error instanceof Error ? error.message : "Không gửi được." });
        optsRef.current.onError(error instanceof Error ? error.message : "Không gửi được.");
      }
    },
    [follow, refresh],
  );

  const stop = useCallback(
    async (threadId: string) => {
      const run = views[threadId]?.running;
      const id = run?.id ?? [...follows.current.entries()].find(([, f]) => f.threadId === threadId)?.[0];
      if (id) await stopTurn(id).catch(() => undefined);
      void refresh(threadId);
    },
    [views, refresh],
  );

  const cancel = useCallback(
    async (threadId: string, id: string, messageIds: string[]) => {
      const out = await cancelQueued(threadId, id).catch(() => ({ ok: false }));
      if (out.ok) for (const mid of messageIds) store().patchMessage(threadId, mid, { notice: "Đã huỷ khỏi hàng đợi." });
      void refresh(threadId);
    },
    [refresh],
  );

  const runningIn = (threadId: string | null) => {
    if (!threadId) return false;
    if ([...follows.current.values()].some((f) => f.threadId === threadId)) return true;
    const r = views[threadId]?.running;
    return Boolean(r && (r.status === "running" || r.status === "waiting"));
  };

  return { queueOn, views, send, stop, cancel, runningIn, refresh };
}

/** Queue strip above the composer: queued items (cancel each) + messages waiting to be steered in. */
export function QueueStrip({ view, onCancel }: { view?: TurnsView; onCancel: (id: string, messageIds: string[]) => void }) {
  if (!view || (!view.queue.length && !view.steerPending.length)) return null;
  return (
    <div className="flex flex-col gap-1 rounded-xl bg-surface px-3 py-2 text-sm shadow-ring" aria-label="Hàng đợi">
      {view.steerPending.map((m) => (
        <div key={m.id} className="flex items-center gap-2 text-muted">
          <CornerDownRight className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">Chờ chèn vào lượt đang chạy: {m.preview}</span>
          <button type="button" className="min-h-9 px-2 hover:text-fg" aria-label="Huỷ tin chờ" onClick={() => onCancel(m.id, [m.id])}>
            <X className="size-4" />
          </button>
        </div>
      ))}
      {view.queue.map((q, i) => (
        <div key={q.id} className="flex items-center gap-2 text-muted">
          <ListPlus className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            Xếp hàng #{i + 1}: {q.messages.map((m) => m.preview).join(" · ")}
          </span>
          <button type="button" className="min-h-9 px-2 hover:text-fg" aria-label="Huỷ mục xếp hàng" onClick={() => onCancel(q.id, q.messages.map((m) => m.id))}>
            <X className="size-4" />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Send + menu (click the chevron or long-press Send): queue / parallel / stop & send. */
export function SendControls({ busy, disabled, onSend, onStop, send }: { busy: boolean; disabled: boolean; onSend: (mode: SendMode) => void; onStop: () => void; send: ReactNode }) {
  const [open, setOpen] = useState(false);
  const press = useRef<number | null>(null);
  const long = useRef(false);
  const pick = (mode: SendMode) => {
    setOpen(false);
    onSend(mode);
  };
  return (
    <div className="relative flex shrink-0 items-end gap-1">
      {busy && (
        <button type="button" onClick={onStop} aria-label="Dừng" title="Dừng lượt đang chạy" className="grid size-11 place-items-center rounded-xl bg-fg text-bg">
          <Square className="size-4" />
        </button>
      )}
      <button
        type="button"
        aria-label={busy ? "Gửi (chèn vào lượt đang chạy)" : "Gửi"}
        title={busy ? "Gửi: Sable đọc tin này ngay ở bước kế tiếp. Giữ để chọn cách gửi." : "Gửi"}
        disabled={disabled}
        onPointerDown={() => {
          long.current = false;
          press.current = window.setTimeout(() => {
            long.current = true;
            setOpen(true);
          }, 500);
        }}
        onPointerUp={() => press.current !== null && window.clearTimeout(press.current)}
        onPointerLeave={() => press.current !== null && window.clearTimeout(press.current)}
        onContextMenu={(e) => {
          e.preventDefault();
          if (!disabled) setOpen(true);
        }}
        onClick={() => {
          if (long.current) return;
          onSend("auto");
        }}
        className="grid size-11 place-items-center rounded-xl bg-accent text-ink disabled:opacity-40"
      >
        {send}
      </button>
      <button type="button" aria-label="Cách gửi" aria-expanded={open} disabled={disabled} onClick={() => setOpen((v) => !v)} className="grid h-11 w-6 place-items-center rounded-xl text-muted hover:text-fg disabled:opacity-40">
        <ChevronDown className="size-4" />
      </button>
      {open && !disabled && (
        <div role="menu" className="absolute right-0 bottom-12 z-20 w-60 rounded-xl bg-surface p-1 text-sm shadow-ring-strong">
          <MenuItem icon={<CornerDownRight className="size-4" />} label="Gửi (chèn vào lượt đang chạy)" onClick={() => pick("steer")} />
          <MenuItem icon={<ListPlus className="size-4" />} label="Xếp hàng" hint="Chạy sau lượt hiện tại" onClick={() => pick("queue")} />
          <MenuItem icon={<GitFork className="size-4" />} label="Chạy song song" hint="Việc nền, trả lời theo luồng" onClick={() => pick("fork")} />
          <MenuItem icon={<Square className="size-4" />} label="Dừng & gửi" hint="Dừng lượt đang chạy rồi gửi" onClick={() => pick("interrupt")} />
        </div>
      )}
    </div>
  );
}

function MenuItem({ icon, label, hint, onClick }: { icon: ReactNode; label: string; hint?: string; onClick: () => void }) {
  return (
    <button type="button" role="menuitem" onClick={onClick} className="flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left hover:bg-fg/5">
      <span className="mt-0.5 text-muted">{icon}</span>
      <span>
        <span className="block">{label}</span>
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </span>
    </button>
  );
}

export function QuoteChip({ quote, onClear }: { quote: Quote; onClear: () => void }) {
  return (
    <div className="flex items-center gap-2 rounded-xl bg-surface px-3 py-2 text-sm shadow-ring" aria-label="Đang trả lời tin">
      <MessageSquareReply className="size-4 shrink-0 text-accent" />
      <span className="min-w-0 flex-1 truncate text-muted">
        Trả lời {quote.role === "assistant" ? "Sable" : "bạn"}: {quote.excerpt.slice(0, 160)}
      </span>
      <button type="button" aria-label="Bỏ trích dẫn" className="min-h-9 px-1 text-muted hover:text-fg" onClick={onClear}>
        <X className="size-4" />
      </button>
    </div>
  );
}

/** The quoted snippet above a message that replies to another; click → scroll to the original. */
export function QuotedSnippet({ target }: { target?: ChatMessage }) {
  if (!target) return null;
  return (
    <button
      type="button"
      onClick={() => document.getElementById(`msg-${target.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}
      className="mb-1 flex max-w-full items-center gap-1 rounded-lg border-l-2 border-accent bg-fg/5 px-2 py-1 text-left text-xs text-muted hover:text-fg"
      title="Tới tin gốc"
    >
      <MessageSquareReply className="size-3 shrink-0" />
      <span className="truncate">{target.content.replace(/\s+/g, " ").slice(0, 140) || "(tin)"}</span>
    </button>
  );
}

export function deliveryLabel(m: ChatMessage) {
  if (m.delivery === "steered") return "↪ đã chèn vào lượt đang chạy";
  if (m.delivery === "queued") return "⏳ xếp hàng";
  if (m.delivery === "fork") return "⑂ chạy song song";
  return "";
}

/** Collapsible threaded replies (fork / late results) under the message they answer. */
export function ThreadedReplies({ replies, render }: { replies: ChatMessage[]; render: (m: ChatMessage) => ReactNode }) {
  const [open, setOpen] = useState(true);
  if (!replies.length) return null;
  return (
    <div className="ml-4 border-l-2 border-fg/10 pl-3" aria-label="Trả lời theo luồng">
      <button type="button" className="mb-1 flex min-h-9 items-center gap-1 text-xs text-muted hover:text-fg" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <GitFork className="size-3" />
        {replies.length} trả lời theo luồng {open ? "▾" : "▸"}
      </button>
      {open && <div className="flex flex-col gap-3">{replies.map((m) => <div key={m.id}>{render(m)}</div>)}</div>}
    </div>
  );
}
