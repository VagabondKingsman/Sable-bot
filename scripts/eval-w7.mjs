/**
 * W7 eval (non-blocking chat). Offline: turn-manager + Telegram W7 unit suites; E2E with a mock model
 * provider (scripted Responses / chat SSE frames) through the real agent loop: steer delivered at the
 * safe point as a new user message, burst coalescing (one model run with all messages), queue FIFO +
 * history carry-over, global cap across threads, interrupt, reconnect replay by seq.
 * Live (running Sable): /api/turns view + validation + CSRF, stream 404 for unknown turns, cancel of an
 * unknown id; optional real-model steer check when SABLE_EVAL_LIVE_MODEL=1.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const results = [];
const pass = (n) => (results.push(["PASS", n]), console.log("PASS", n));
const skip = (n, why) => (results.push(["SKIP", n]), console.log("SKIP", n, "-", why));
function fail(n, e) {
  results.push(["FAIL", n]);
  console.error("FAIL", n, e?.message || e);
  process.exitCode = 1;
}
async function run(name, fn) {
  try {
    const r = await fn();
    if (typeof r === "string" && r.startsWith("skip")) return skip(name, r.slice(5) || "skipped");
    pass(name);
  } catch (e) {
    fail(name, e);
  }
}

const BASE = process.env.SABLE_EVAL_URL || "http://127.0.0.1:8080";
const ORIGIN = { origin: BASE.replace("localhost", "127.0.0.1") };

const { TurnManager } = await import("../src/lib/agent/turns/manager.ts");
const { steerText } = await import("../src/lib/agent/turns/reply.ts");
const { runAgent } = await import("../src/lib/agent/loop.ts");
const { responsesAdapter, chatAdapter } = await import("../src/lib/agent/adapters.ts");
const { assemble } = await import("../src/lib/agent/assemble.ts");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 3_000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timeout");
    await sleep(3);
  }
}

for (const file of ["src/lib/agent/turns/manager.test.ts", "src/lib/agent/channels-w7.test.ts"]) {
  await run(`unit:${file.split("/").pop()}`, () => {
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--test", file], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME } });
    if (r.status !== 0) throw new Error((r.stdout + r.stderr).split("\n").filter((l) => /✖|fail/.test(l)).slice(0, 6).join(" | "));
  });
}

const slowTool = {
  kind: "function",
  name: "look",
  description: "look around",
  parameters: { type: "object", properties: { what: { type: "string" } }, required: ["what"] },
  risk: "read",
  timeoutMs: 2_000,
  maxOutput: 1_000,
  label: (a) => `Xem · ${a.what}`,
  run: async (a) => (await sleep(60), { ok: true, output: `seen ${a.what}` }),
};

/** Mock provider: tool call first, then a text answer that echoes how many user messages it saw. */
function mockProvider(style) {
  const bodies = [];
  const transport = async function* (_path, body, signal) {
    bodies.push(structuredClone(body));
    const n = bodies.length;
    await sleep(20);
    if (signal?.aborted) throw new Error("aborted");
    const items = style === "chat" ? body.messages : body.input;
    const isFirstOfTurn = style === "chat" ? !items.some((m) => m.role === "tool") : !body.previous_response_id;
    if (isFirstOfTurn) {
      if (style === "chat") yield { event: "", json: { choices: [{ delta: { tool_calls: [{ index: 0, id: `c${n}`, function: { name: "look", arguments: '{"what":"desk"}' } }] }, finish_reason: "tool_calls" }] } };
      else {
        yield { event: "response.created", json: { type: "response.created", response: { id: `resp_${n}` } } };
        yield { event: "", json: { type: "response.output_item.done", item: { type: "function_call", call_id: `fc_${n}`, name: "look", arguments: '{"what":"desk"}' } } };
      }
      return;
    }
    const steered = items.filter((m) => m.role === "user" && typeof m.content === "string" && m.content.startsWith("[New message from the owner")).length;
    const text = `answer(steered=${steered})`;
    if (style === "chat") yield { event: "", json: { choices: [{ delta: { content: text }, finish_reason: "stop" }] } };
    else yield { event: "", json: { type: "response.output_text.delta", delta: text } };
  };
  return { transport, bodies };
}

function managerWith(style, cap = 3) {
  const mock = mockProvider(style);
  const runs = [];
  const m = new TurnManager({
    cap: () => cap,
    build: (base, history, msgs) => ({ ...base, messages: [...history, ...msgs.map((x) => ({ role: "user", content: x.content }))] }),
    run: async (h) => {
      runs.push(h.messages.map((x) => x.content));
      const assembled = assemble({ instructions: "I", memory: "", messages: h.request.messages, tools: [slowTool] });
      const out = await runAgent(assembled, {
        adapter: style === "chat" ? chatAdapter : responsesAdapter,
        transport: mock.transport,
        tools: [slowTool],
        ctx: { workspaceDir: "/tmp/unused", signal: h.signal, mode: "interactive", initiator: { kind: "user", id: "owner:web" } },
        emit: (e) => h.emit(e.event, e.data),
        opts: { model: "m", effort: "low", maxTokens: 100 },
        steer: () => h.takeSteer().map((x) => steerText(x.content)),
      });
      return { text: out.text };
    },
  });
  return { m, mock, runs };
}
const req = (...c) => ({ model: "m", messages: c.map((content) => ({ role: "user", content })) });
let ids = 0;
const msg = (content) => ({ id: `e${++ids}`, content, at: Date.now() });

for (const style of ["responses", "chat"]) {
  await run(`e2e-mock-${style}-steer-at-safe-point`, async () => {
    const { m, mock } = managerWith(style);
    const a = m.submit({ threadId: "t", message: msg("check the desk"), request: req("check the desk") });
    await until(() => m.session(a.turnId).output); // tool step started → no longer a burst
    const b = m.submit({ threadId: "t", message: msg("also count the pens"), request: req("check the desk", "also count the pens") });
    assert.equal(b.disposition, "steered");
    await until(() => m.session(a.turnId).status === "done");
    const second = mock.bodies[1];
    const items = style === "chat" ? second.messages : second.input;
    const last = items.at(-1);
    assert.equal(last.role, "user");
    assert.match(last.content, /^\[New message from the owner while you were working[^\]]*\]\n\nalso count the pens$/);
    assert.equal(m.session(a.turnId).answer, "answer(steered=1)");
    assert.equal(mock.bodies.length, 2, "one turn, no extra model run");
  });
}

await run("e2e-mock-burst-coalesced-into-one-turn", async () => {
  const { m, mock, runs } = managerWith("responses");
  const a = m.submit({ threadId: "t", message: msg("one"), request: req("one") });
  m.submit({ threadId: "t", message: msg("two"), request: req("one", "two") });
  const c = m.submit({ threadId: "t", message: msg("three"), request: req("one", "two", "three") });
  assert.equal(c.disposition, "coalesced");
  await until(() => m.session(a.turnId).status === "done");
  assert.deepEqual(runs.at(-1), ["one", "two", "three"]);
  const finalFirst = mock.bodies.filter((b) => !b.previous_response_id).at(-1);
  assert.deepEqual(finalFirst.input.filter((x) => x.role === "user").map((x) => x.content), ["one", "two", "three"]);
});

await run("e2e-mock-queue-fifo-history-cap-interrupt-reconnect", async () => {
  const { m, runs } = managerWith("responses", 1);
  const a = m.submit({ threadId: "A", message: msg("a1"), request: req("a1") });
  const other = m.submit({ threadId: "B", message: msg("b1"), request: req("b1") });
  assert.equal(other.disposition, "waiting", "global cap 1 → second thread waits");
  await until(() => m.session(a.turnId).output);
  const q = m.submit({ threadId: "A", message: msg("a2"), mode: "queue", request: req("a1", "a2") });
  assert.equal(q.disposition, "queued");
  await until(() => runs.length >= 3, 5_000);
  assert.deepEqual(runs.slice(0, 3), [["a1"], ["b1"], ["a2"]], "FIFO across the cap; A's queue after B started");
  // interrupt + reconnect replay
  const x = m.submit({ threadId: "C", message: msg("long"), request: req("long") });
  await until(() => m.session(x.turnId).status === "running" && m.session(x.turnId).output, 5_000);
  const y = m.submit({ threadId: "C", message: msg("instead"), mode: "interrupt", request: req("long", "instead") });
  assert.equal(y.disposition, "interrupted");
  assert.equal(m.session(x.turnId).status, "stopped");
  await until(() => m.session(y.turnId).status === "done", 5_000);
  const seen = [];
  m.subscribe(y.turnId, 2, (e) => seen.push(e.seq));
  assert.ok(seen.length > 0 && seen[0] === 3 && seen.at(-1) === -1, "replay from seq 3 then end");
});

// ---------- live ----------
async function up() {
  try {
    return (await fetch(`${BASE}/api/health`)).ok || true;
  } catch (e) {
    console.log("  health:", e?.cause?.code || e?.message);
    return false;
  }
}
if (!(await up())) {
  skip("live", "Sable not running");
} else {
  const post = (body, headers = ORIGIN) => fetch(`${BASE}/api/turns`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  let view;
  await run("live-turns-view", async () => {
    const r = await fetch(`${BASE}/api/turns?thread=evalw7`);
    assert.equal(r.status, 200);
    view = await r.json();
    if (view.enabled === false) return "skip SABLE_CHAT_QUEUE=0";
    assert.ok(view.cap >= 1 && Array.isArray(view.queue) && Array.isArray(view.replies) && "running" in view);
    assert.equal((await fetch(`${BASE}/api/turns?thread=../x`)).status, 400);
  });
  await run("live-turns-validation-csrf", async () => {
    if (view?.enabled === false) return "skip queue off";
    assert.equal((await post({ action: "stop", turnId: "turn_x" }, { origin: "https://evil.example" })).status, 403);
    assert.equal((await post({ action: "nope" })).status, 400);
    assert.equal((await post({ action: "submit", threadId: "evalw7", messageId: "m1", request: { model: "bogus", messages: [] } })).status, 400);
    assert.equal((await post({ action: "submit", threadId: "../x", messageId: "m1", request: {} })).status, 400);
    assert.deepEqual(await (await post({ action: "stop", turnId: "turn_doesnotexist" })).json(), { ok: false });
    assert.deepEqual(await (await post({ action: "cancel", threadId: "evalw7", id: "q_none" })).json(), { ok: false });
    assert.equal((await fetch(`${BASE}/api/turns/stream?turn=turn_doesnotexist`)).status, 404);
    assert.equal((await fetch(`${BASE}/api/turns/stream?turn=../x`)).status, 400);
  });
  await run("live-real-model-steer", async () => {
    if (process.env.SABLE_EVAL_LIVE_MODEL !== "1") return "skip set SABLE_EVAL_LIVE_MODEL=1 (uses the real model)";
    const models = (await (await fetch(`${BASE}/api/chat`)).json()).models ?? [];
    const model = models.at(-1);
    const T = `evalw7${Date.now().toString(36)}`;
    const body = (content) => ({ model, effort: "low", instructions: "", memory: "", tools: { web: false, x: false, code: false, image: false, files: true, fetch: false }, messages: [{ role: "user", content }] });
    const a = await (await post({ action: "submit", threadId: T, messageId: "u1", request: body("Step by step: list the workspace root with your file tool, then list code/, then list media/, one tool call at a time, then summarize.") })).json();
    await sleep(3_000);
    const b = await (await post({ action: "submit", threadId: T, messageId: "u2", request: body("Also: end your answer with the word PINEAPPLE.") })).json();
    assert.equal(b.disposition, "steered", JSON.stringify(b));
    const text = await (await fetch(`${BASE}/api/turns/stream?turn=${a.turnId}&after=0`)).text();
    assert.match(text, /event: steered/);
    let answer = "";
    for (const block of text.split("\n\n")) {
      if (!/^event: delta$/m.test(block)) continue;
      const d = JSON.parse(block.match(/^data: (.*)$/m)[1]);
      answer += typeof d === "string" ? d : d.text ?? d.delta ?? "";
    }
    assert.match(answer, /PINEAPPLE/i, "steered instruction followed (answer streamed token by token)");
  });
}

const p = results.filter((r) => r[0] === "PASS").length;
const fl = results.filter((r) => r[0] === "FAIL").length;
const sk = results.filter((r) => r[0] === "SKIP").length;
console.log(fl ? `${p} pass, ${fl} fail, ${sk} skip` : `all w7 eval checks passed (${p} pass, ${sk} skip)`);
