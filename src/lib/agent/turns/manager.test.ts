import { test } from "node:test";
import assert from "node:assert/strict";
import { TurnManager, type TurnHandle, type HistoryMsg, type UserMsg } from "./manager.ts";
import { appendUserMessages } from "../loop.ts";

type Req = { messages: HistoryMsg[] };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const msg = (content: string, at = 0): UserMsg => ({ id: `m${++n}`, content, at });
const req = (...c: string[]): Req => ({ messages: c.map((content) => ({ role: "user", content })) });

function setup(opts: { cap?: number; coalesceMs?: number; steps?: number; stepMs?: number } = {}) {
  const calls: { id: string; thread: string; msgs: string[]; history: HistoryMsg[] }[] = [];
  const steered: string[][] = [];
  let clock = 1_000;
  let concurrent = 0;
  let peak = 0;
  const run = async (h: TurnHandle<Req>) => {
    calls.push({ id: h.id, thread: h.threadId, msgs: h.messages.map((m) => m.content), history: h.request.messages });
    concurrent++;
    peak = Math.max(peak, concurrent);
    try {
      for (let i = 0; i < (opts.steps ?? 3); i++) {
        await tick(opts.stepMs ?? 5);
        if (h.signal.aborted) throw new Error("aborted");
        if (i === 0) h.emit("delta", { text: "x" });
        if (i === (opts.steps ?? 3) - 1) break; // the final model answer: no safe point after it
        const s = h.takeSteer();
        if (s.length) steered.push(s.map((m) => m.content));
      }
      return { text: `answer:${h.messages.map((m) => m.content).join("+")}` };
    } finally {
      concurrent--;
    }
  };
  const m = new TurnManager<Req>({
    run,
    build: (_b, history, msgs) => ({ messages: [...history, ...msgs.map((x) => ({ role: "user" as const, content: x.content }))] }),
    cap: () => opts.cap ?? 3,
    coalesceMs: opts.coalesceMs ?? 1_500,
    now: () => clock,
  });
  return { m, calls, steered, advance: (ms: number) => (clock += ms), peak: () => peak };
}

async function until(fn: () => boolean, ms = 2_000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timeout");
    await tick(2);
  }
}

test("steer: a message during a running turn is delivered at the next safe point", async () => {
  const { m, steered, advance } = setup({ steps: 4 });
  const a = m.submit({ threadId: "t", message: msg("first"), request: req("first") });
  assert.equal(a.disposition, "started");
  await tick(8); // first delta emitted → no longer a burst
  advance(2_000);
  const b = m.submit({ threadId: "t", message: msg("also this"), request: req("first", "also this") });
  assert.equal(b.disposition, "steered");
  assert.equal(b.turnId, a.turnId);
  await until(() => m.session(a.turnId!)!.status === "done");
  assert.deepEqual(steered, [["also this"]]);
  assert.deepEqual(m.session(a.turnId!)!.steered.map((x) => x.content), ["also this"]);
  assert.ok(m.session(a.turnId!)!.events.some((e) => e.event === "steered"));
});

test("burst: messages sent quickly before any output are coalesced into one turn (restart)", async () => {
  const { m, calls } = setup({ steps: 2, stepMs: 20 });
  const a = m.submit({ threadId: "t", message: msg("one"), request: req("one") });
  await tick(1);
  const b = m.submit({ threadId: "t", message: msg("two"), request: req("one", "two") });
  const c = m.submit({ threadId: "t", message: msg("three"), request: req("one", "two", "three") });
  assert.equal(b.disposition, "coalesced");
  assert.equal(c.disposition, "coalesced");
  await until(() => m.session(a.turnId!)!.status === "done");
  const s = m.session(a.turnId!)!;
  assert.equal(s.answer, "answer:one+two+three");
  assert.ok(s.restarts >= 1);
  assert.deepEqual(calls.at(-1)!.msgs, ["one", "two", "three"]);
  assert.deepEqual(calls.at(-1)!.history.map((h) => h.content), ["one", "two", "three"]);
});

test("queue: FIFO after the current turn; quick queued messages merge; history carries over", async () => {
  const { m, calls, advance } = setup({ steps: 2 });
  m.submit({ threadId: "t", message: msg("a"), request: req("a") });
  await tick(8);
  advance(2_000);
  const q1 = m.submit({ threadId: "t", message: msg("b"), mode: "queue", request: req("a", "b") });
  const q1b = m.submit({ threadId: "t", message: msg("b2"), mode: "queue", request: req("a", "b", "b2") });
  advance(2_000);
  const q2 = m.submit({ threadId: "t", message: msg("c"), mode: "queue", request: req("a", "b", "b2", "c") });
  assert.equal(q1.disposition, "queued");
  assert.equal(q1b.queueId, q1.queueId);
  assert.notEqual(q2.queueId, q1.queueId);
  assert.equal(m.view("t").queue.length, 2);
  await until(() => calls.length === 3 && m.view("t").running === null);
  assert.deepEqual(calls.map((c) => c.msgs), [["a"], ["b", "b2"], ["c"]]);
  assert.deepEqual(calls[2].history.map((h) => h.content), ["a", "answer:a", "b", "b2", "answer:b+b2", "c"]);
});

test("cancel: a queued item can be cancelled; stop frees the thread", async () => {
  const { m, calls, advance } = setup({ steps: 50 });
  const a = m.submit({ threadId: "t", message: msg("long"), request: req("long") });
  await tick(8);
  advance(2_000);
  const q = m.submit({ threadId: "t", message: msg("later"), mode: "queue", request: req("long", "later") });
  assert.ok(m.cancelQueued("t", q.queueId!));
  assert.equal(m.view("t").queue.length, 0);
  assert.ok(m.stop(a.turnId!));
  assert.equal(m.session(a.turnId!)!.status, "stopped");
  await tick(20);
  assert.equal(calls.length, 1);
  assert.equal(m.view("t").running, null);
});

test("interrupt: stop & send aborts the running turn and starts a new one first", async () => {
  const { m, calls, advance } = setup({ steps: 50 });
  const a = m.submit({ threadId: "t", message: msg("slow"), request: req("slow") });
  await tick(8);
  advance(2_000);
  m.submit({ threadId: "t", message: msg("queued"), mode: "queue", request: req("slow", "queued") });
  const b = m.submit({ threadId: "t", message: msg("now"), mode: "interrupt", request: req("slow", "now") });
  assert.equal(b.disposition, "interrupted");
  assert.equal(m.session(a.turnId!)!.status, "stopped");
  await until(() => calls.length >= 2);
  assert.deepEqual(calls[1].msgs, ["now"]);
  assert.equal(m.view("t").queue.length, 1);
  m.stop(b.turnId!);
});

test("cap: at most N turns run across threads; each thread strictly serialized", async () => {
  const { m, peak } = setup({ cap: 2, steps: 3, stepMs: 10 });
  const ids = ["t1", "t2", "t3", "t4"].map((t) => m.submit({ threadId: t, message: msg(t), request: req(t) }));
  await tick(1);
  assert.equal(m.stats().active, 2);
  assert.equal(ids.filter((r) => m.session(r.turnId!)!.status === "waiting").length, 2);
  await until(() => ids.every((r) => m.session(r.turnId!)!.status === "done"));
  assert.equal(peak(), 2);
});

test("reconnect: subscribe replays events after a seq, then follows live and ends", async () => {
  const { m } = setup({ steps: 3, stepMs: 10 });
  const a = m.submit({ threadId: "t", message: msg("hi"), request: req("hi") });
  await tick(15);
  const seen: string[] = [];
  const first = m.session(a.turnId!)!.events[0].seq;
  let ended = false;
  m.subscribe(a.turnId!, first, (e) => (e.event === "end" ? (ended = true) : seen.push(`${e.seq}:${e.event}`)));
  await until(() => ended);
  const seqs = seen.map((s) => Number(s.split(":")[0]));
  assert.ok(seqs[0] > first);
  assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y));
  assert.ok(seen.some((s) => s.endsWith(":done")));
  // after the end, a late subscriber gets the full replay + end immediately
  let replay = 0;
  let end2 = false;
  m.subscribe(a.turnId!, 0, (e) => (e.event === "end" ? (end2 = true) : replay++));
  assert.ok(end2 && replay === m.session(a.turnId!)!.events.length);
});

test("leftover steer messages (arrived after the last safe point) become the next turn", async () => {
  const { m, calls, advance } = setup({ steps: 1, stepMs: 15 });
  m.submit({ threadId: "t", message: msg("a"), request: req("a") });
  await tick(2);
  advance(2_000);
  // force "output" so this is not a burst
  const run = m.view("t").running!;
  m.session(run.id)!.output = true;
  m.submit({ threadId: "t", message: msg("late"), request: req("a", "late") });
  await until(() => calls.length === 2 && m.view("t").running === null);
  assert.deepEqual(calls[1].msgs, ["late"]);
});

test("appendUserMessages targets Responses input or chat messages", () => {
  assert.deepEqual(appendUserMessages({ input: [{ a: 1 }] }, ["x"]).input, [{ a: 1 }, { role: "user", content: "x" }]);
  assert.deepEqual(appendUserMessages({ messages: [] }, ["y"]).messages, [{ role: "user", content: "y" }]);
  assert.deepEqual(appendUserMessages({ input: [] }, []), { input: [] });
});
