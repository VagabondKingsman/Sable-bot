/**
 * W7 turn manager: per-thread serialized turns with a steer inbox, a visible queue, burst coalescing,
 * a global concurrency cap and resumable event logs (turn id + seq), modelled on how a chat agent
 * handles messages that arrive while it is working:
 *  - auto/steer: same thread busy → the message joins the running turn at the next safe point
 *    (between model/tool steps); if the turn has produced no output yet (burst), it is coalesced and
 *    the turn restarts with all messages at once.
 *  - queue: runs after the current turn (messages queued within the coalesce window merge).
 *  - interrupt: stop the current turn, then run (with any undelivered steer messages) right away.
 * Undelivered steer messages after a turn ends become the next turn (front of the queue).
 * Pure and dependency-free: the runner (model loop) and the clock are injected.
 */

export type TurnMode = "auto" | "steer" | "queue" | "interrupt";
export type UserMsg = { id: string; content: string; replyTo?: string; at: number };
export type HistoryMsg = { role: "user" | "assistant"; content: string };
export type TurnStatus = "waiting" | "running" | "done" | "error" | "stopped" | "cancelled";
export type TurnEvent = { seq: number; event: string; data: unknown };

export type TurnHandle<R> = {
  id: string;
  threadId: string;
  request: R;
  messages: UserMsg[];
  signal: AbortSignal;
  emit: (event: string, data: unknown) => void;
  /** Safe point: take messages that arrived while working (marks them delivered). */
  takeSteer: () => UserMsg[];
};
export type Runner<R> = (h: TurnHandle<R>) => Promise<{ text: string }>;

export type Session<R> = {
  id: string;
  threadId: string;
  status: TurnStatus;
  messages: UserMsg[];
  steered: UserMsg[];
  events: TurnEvent[];
  seq: number;
  answer: string;
  error?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  restarts: number;
  /** Output seen (delta/step/approval…): no more burst restarts. */
  output: boolean;
  base: R;
  history: HistoryMsg[];
};
export type QueueItem<R> = { id: string; threadId: string; messages: UserMsg[]; createdAt: number; base: R };

type ThreadState<R> = { running: Session<R> | null; queue: QueueItem<R>[]; inbox: UserMsg[]; history: HistoryMsg[] | null };
type Live<R> = { session: Session<R>; ctrl: AbortController; restart: boolean; subs: Set<(e: TurnEvent) => void> };

export type ManagerOptions<R> = {
  run: Runner<R>;
  /** Build the model request for a session: history + this turn's user messages. */
  build: (base: R, history: HistoryMsg[], messages: UserMsg[]) => R;
  /** Global cap across threads (read on every start, so it can shrink while heavy agents run). */
  cap: () => number;
  coalesceMs?: number;
  now?: () => number;
  newId?: (prefix: string) => string;
  maxEvents?: number;
  keepFinished?: number;
  keepMs?: number;
  onFinish?: (s: Session<R>) => void;
};

export type Submit<R> = { threadId: string; message: UserMsg; mode?: TurnMode; request: R & { messages: HistoryMsg[] } };
export type Disposition = "started" | "waiting" | "steered" | "coalesced" | "queued" | "interrupted";
export type SubmitResult = { disposition: Disposition; turnId?: string; queueId?: string };

const OUTPUT = new Set(["delta", "step", "thought", "approval", "image", "citation"]);
let counter = 0;
const defaultId = (p: string) => `${p}_${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 8)}`;

export class TurnManager<R> {
  private readonly o: Required<Omit<ManagerOptions<R>, "onFinish">> & Pick<ManagerOptions<R>, "onFinish">;
  private readonly threads = new Map<string, ThreadState<R>>();
  private readonly sessions = new Map<string, Session<R>>();
  private readonly live = new Map<string, Live<R>>();
  private active = 0;
  private waiters: (() => void)[] = [];

  constructor(opts: ManagerOptions<R>) {
    this.o = { coalesceMs: 1_500, now: Date.now, newId: defaultId, maxEvents: 20_000, keepFinished: 200, keepMs: 30 * 60_000, ...opts };
  }

  private t(threadId: string) {
    let t = this.threads.get(threadId);
    if (!t) this.threads.set(threadId, (t = { running: null, queue: [], inbox: [], history: null }));
    return t;
  }

  submit(input: Submit<R>): SubmitResult {
    const mode = input.mode ?? "auto";
    const t = this.t(input.threadId);
    const msg = input.message;
    const run = t.running;
    const now = this.o.now();
    if (run && mode === "interrupt") {
      // Take leftovers + park the queue so stop() does not start anything else first.
      const leftovers = t.inbox.splice(0);
      const parked = t.queue.splice(0);
      this.stop(run.id, "stopped");
      t.queue.push(...parked);
      const s = this.startSession(input.threadId, [...leftovers, msg], input.request, t.history ?? input.request.messages.slice(0, -1), true);
      return { disposition: "interrupted", turnId: s.id };
    }
    if (run && (mode === "auto" || mode === "steer")) {
      const l = this.live.get(run.id);
      const burst = !run.output && (run.status === "waiting" || (run.startedAt !== undefined && now - run.startedAt <= this.o.coalesceMs));
      if (burst) {
        run.messages.push(msg);
        if (l && run.status === "running") {
          l.restart = true;
          l.ctrl.abort(new Error("coalesce"));
        }
        return { disposition: "coalesced", turnId: run.id };
      }
      t.inbox.push(msg);
      this.emitTo(run, "steer_queued", { id: msg.id });
      return { disposition: "steered", turnId: run.id };
    }
    if (run || t.queue.length) {
      // queue (or auto while idle-but-queued): merge into a fresh queue item inside the burst window.
      const last = t.queue[t.queue.length - 1];
      if (last && now - last.createdAt <= this.o.coalesceMs) {
        last.messages.push(msg);
        return { disposition: "queued", queueId: last.id };
      }
      const item: QueueItem<R> = { id: this.o.newId("q"), threadId: input.threadId, messages: [msg], createdAt: now, base: input.request };
      t.queue.push(item);
      if (!run) this.next(input.threadId);
      return { disposition: "queued", queueId: item.id };
    }
    const s = this.startSession(input.threadId, [msg], input.request, input.request.messages.slice(0, -1), false);
    return { disposition: s.status === "waiting" ? "waiting" : "started", turnId: s.id };
  }

  private startSession(threadId: string, messages: UserMsg[], base: R, history: HistoryMsg[], _front: boolean): Session<R> {
    const t = this.t(threadId);
    const s: Session<R> = { id: this.o.newId("turn"), threadId, status: "waiting", messages, steered: [], events: [], seq: 0, answer: "", createdAt: this.o.now(), restarts: 0, output: false, base, history };
    this.sessions.set(s.id, s);
    t.running = s;
    const l: Live<R> = { session: s, ctrl: new AbortController(), restart: false, subs: new Set() };
    this.live.set(s.id, l);
    this.emitTo(s, "turn", { id: s.id, threadId, messageIds: messages.map((m) => m.id), status: "waiting" });
    void this.drive(l);
    this.gc();
    return s;
  }

  private async acquire(signal: AbortSignal, granted: () => void) {
    while (this.active >= Math.max(1, this.o.cap())) {
      if (signal.aborted) return false;
      await new Promise<void>((resolve) => {
        const done = () => (signal.removeEventListener("abort", done), resolve());
        this.waiters.push(done);
        signal.addEventListener("abort", done, { once: true });
      });
    }
    if (signal.aborted) return false;
    this.active += 1;
    granted();
    return true;
  }

  private release() {
    this.active = Math.max(0, this.active - 1);
    const w = this.waiters.splice(0);
    for (const f of w) f();
  }

  /** Re-check waiters (e.g. the cap grew after a heavy agent finished). */
  poke() {
    const w = this.waiters.splice(0);
    for (const f of w) f();
  }

  private async drive(l: Live<R>) {
    const s = l.session;
    const stopSignal = l.ctrl.signal;
    const grant = () => {
      if (s.status === "waiting") s.status = "running";
      s.startedAt ??= this.o.now();
    };
    if (!(await this.acquire(stopSignal, grant))) {
      this.finish(s, "stopped");
      return;
    }
    try {
      for (;;) {
        if (s.status !== "waiting" && s.status !== "running") return;
        s.status = "running";
        s.startedAt ??= this.o.now();
        this.emitTo(s, "status_turn", { status: "running", messageIds: s.messages.map((m) => m.id) });
        const ctrl = l.ctrl.signal.aborted ? (l.ctrl = new AbortController()) : l.ctrl;
        l.restart = false;
        try {
          const request = this.o.build(s.base, s.history, s.messages);
          const out = await this.o.run({
            id: s.id,
            threadId: s.threadId,
            request,
            messages: s.messages.slice(),
            signal: ctrl.signal,
            emit: (event, data) => this.emitTo(s, event, data),
            takeSteer: () => this.takeSteer(s),
          });
          if (l.restart) {
            s.restarts += 1;
            this.emitTo(s, "reset", { messageIds: s.messages.map((m) => m.id) });
            continue;
          }
          if (ctrl.signal.aborted || s.finishedAt) return void this.finish(s, "stopped");
          if (out.text) s.answer = out.text;
          return void this.finish(s, "done");
        } catch (error) {
          if (l.restart) {
            s.restarts += 1;
            this.emitTo(s, "reset", { messageIds: s.messages.map((m) => m.id) });
            continue;
          }
          if (ctrl.signal.aborted || s.finishedAt) return void this.finish(s, "stopped");
          s.error = error instanceof Error ? error.message.slice(0, 240) : "error";
          return void this.finish(s, "error");
        }
      }
    } finally {
      this.release();
    }
  }

  private takeSteer(s: Session<R>) {
    const t = this.t(s.threadId);
    if (t.running !== s || !t.inbox.length) return [];
    const got = t.inbox.splice(0);
    s.steered.push(...got);
    s.output = true;
    this.emitTo(s, "steered", { ids: got.map((m) => m.id) });
    return got;
  }

  private finish(s: Session<R>, status: TurnStatus) {
    if (s.finishedAt) return;
    s.status = status;
    s.finishedAt = this.o.now();
    const t = this.t(s.threadId);
    const user = [...s.messages, ...s.steered].map((m) => ({ role: "user" as const, content: m.content }));
    t.history = [...s.history, ...user, ...(s.answer ? [{ role: "assistant" as const, content: s.answer }] : [])];
    this.emitTo(s, status === "done" ? "done" : status === "error" ? "error" : "stopped", status === "error" ? { message: s.error ?? "error" } : { status });
    const l = this.live.get(s.id);
    if (l) {
      for (const sub of l.subs) sub({ seq: -1, event: "end", data: { status } });
      l.subs.clear();
      this.live.delete(s.id);
    }
    if (t.running === s) {
      t.running = null;
      this.next(s.threadId);
    }
    try {
      this.o.onFinish?.(s);
    } catch {
      /* observer errors never break the queue */
    }
  }

  /** Start whatever is next for a thread: undelivered steer messages first, then the queue. */
  private next(threadId: string) {
    const t = this.t(threadId);
    if (t.running) return;
    if (t.inbox.length) {
      const msgs = t.inbox.splice(0);
      const base = t.queue[0]?.base ?? this.lastBase(threadId);
      if (base !== undefined) return void this.startSession(threadId, msgs, base, t.history ?? [], true);
    }
    const item = t.queue.shift();
    if (item) this.startSession(threadId, item.messages, item.base, t.history ?? (item.base as { messages: HistoryMsg[] }).messages.slice(0, -1), false);
  }

  private lastBase(threadId: string): R | undefined {
    let best: Session<R> | undefined;
    for (const s of this.sessions.values()) if (s.threadId === threadId && (!best || s.createdAt >= best.createdAt)) best = s;
    return best?.base;
  }

  private emitTo(s: Session<R>, event: string, data: unknown) {
    if (OUTPUT.has(event)) s.output = true;
    if (event === "delta" && typeof (data as { text?: unknown })?.text === "string") s.answer += (data as { text: string }).text;
    if (event === "reset") s.answer = "";
    const e: TurnEvent = { seq: ++s.seq, event, data };
    if (s.events.length < this.o.maxEvents) s.events.push(e);
    const l = this.live.get(s.id);
    if (l) for (const sub of l.subs) sub(e);
  }

  /** Stop a running/waiting turn (owner). Undelivered steer messages stay for the next turn. */
  stop(turnId: string, status: TurnStatus = "stopped") {
    const s = this.sessions.get(turnId);
    const l = this.live.get(turnId);
    if (!s || !l || s.finishedAt) return false;
    l.restart = false;
    l.ctrl.abort(new Error("stopped"));
    // Finish now so the thread is free immediately; the runner unwinds on the abort signal.
    this.finish(s, status);
    return true;
  }

  /** Cancel a queued item (owner). */
  cancelQueued(threadId: string, queueId: string) {
    const t = this.threads.get(threadId);
    if (!t) return false;
    const i = t.queue.findIndex((q) => q.id === queueId);
    if (i < 0) return false;
    t.queue.splice(i, 1);
    return true;
  }

  /** Drop one undelivered steer message (owner). */
  cancelSteer(threadId: string, messageId: string) {
    const t = this.threads.get(threadId);
    if (!t) return false;
    const i = t.inbox.findIndex((m) => m.id === messageId);
    if (i < 0) return false;
    t.inbox.splice(i, 1);
    return true;
  }

  session(id: string) {
    return this.sessions.get(id);
  }

  /** Replay events after `after`, then follow live ones until the turn ends. Returns an unsubscribe. */
  subscribe(turnId: string, after: number, fn: (e: TurnEvent) => void): (() => void) | null {
    const s = this.sessions.get(turnId);
    if (!s) return null;
    for (const e of s.events) if (e.seq > after) fn(e);
    const l = this.live.get(turnId);
    if (!l) {
      fn({ seq: -1, event: "end", data: { status: s.status } });
      return () => undefined;
    }
    l.subs.add(fn);
    return () => l.subs.delete(fn);
  }

  view(threadId: string) {
    const t = this.threads.get(threadId);
    const recent = [...this.sessions.values()].filter((s) => s.threadId === threadId).sort((a, b) => b.createdAt - a.createdAt).slice(0, 10);
    return {
      running: t?.running ? brief(t.running) : null,
      queue: (t?.queue ?? []).map((q) => ({ id: q.id, createdAt: q.createdAt, messages: q.messages.map((m) => ({ id: m.id, preview: m.content.slice(0, 160) })) })),
      steerPending: (t?.inbox ?? []).map((m) => ({ id: m.id, preview: m.content.slice(0, 160) })),
      recent: recent.map(brief),
    };
  }

  stats() {
    let running = 0;
    let waiting = 0;
    let queued = 0;
    for (const t of this.threads.values()) {
      if (t.running?.status === "running") running++;
      if (t.running?.status === "waiting") waiting++;
      queued += t.queue.length;
    }
    return { active: this.active, cap: Math.max(1, this.o.cap()), running, waiting, queued, sessions: this.sessions.size };
  }

  private gc() {
    const now = this.o.now();
    const done = [...this.sessions.values()].filter((s) => s.finishedAt).sort((a, b) => a.finishedAt! - b.finishedAt!);
    let extra = done.length - this.o.keepFinished;
    for (const s of done) {
      if (extra > 0 || now - s.finishedAt! > this.o.keepMs) {
        this.sessions.delete(s.id);
        extra--;
      }
    }
  }
}

function brief<R>(s: Session<R>) {
  return { id: s.id, status: s.status, seq: s.seq, createdAt: s.createdAt, startedAt: s.startedAt, finishedAt: s.finishedAt, messageIds: s.messages.map((m) => m.id), steeredIds: s.steered.map((m) => m.id), restarts: s.restarts, error: s.error };
}
