/**
 * Sable eval set: `npm run eval` (scripted mock model, deterministic, offline)
 * or `npm run eval -- --real [--model grok-4.7]` (real model from .env.local / env).
 * Cases: evals/*.jsonl. Categories: tool, approval, memory (agent loop), redact,
 * recall, schedule (pure). Prints a scored summary; exit 1 if mock score < 100%
 * (real mode only fails with --strict).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { adapterFor, chatAdapter } from "../src/lib/agent/adapters.ts";
import { assemble } from "../src/lib/agent/assemble.ts";
import { runAgent, type Transport } from "../src/lib/agent/loop.ts";
import { sseFrames, type Frame } from "../src/lib/agent/sse.ts";
import { endpointFor, resolveEndpoints } from "../src/lib/agent/provider.ts";
import { fsList, fsRead, fsWrite } from "../src/lib/agent/tools/fs.ts";
import { shellRun } from "../src/lib/agent/tools/shell.ts";
import { browserTool } from "../src/lib/agent/tools/browser.ts";
import { makeEvent, signBody, WebhookChannel } from "../src/lib/agent/channels/webhook.ts";
import { defaultState, spawnToolsFor } from "../src/lib/agent/profiles.ts";
import { memoryRecall, memorySave, memoryForget } from "../src/lib/agent/tools/memory.ts";
import type { FunctionTool, MemoryAccess, ToolContext } from "../src/lib/agent/tools/types.ts";
import { MemoryStore } from "../src/lib/agent/memory/store.ts";
import { redactSecrets } from "../src/lib/agent/memory/redact.ts";
import { nextRun, validateSchedule } from "../src/lib/agent/jobs/schedule.ts";

type Case = Record<string, any> & { id: string; cat: string };
const argv = process.argv.slice(2);
const REAL = argv.includes("--real");
const STRICT = argv.includes("--strict");
const MODEL = argv[argv.indexOf("--model") + 1] && argv.includes("--model") ? argv[argv.indexOf("--model") + 1] : "grok-4.7";
const ONLY = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : "";
const VERBOSE = argv.includes("-v");

const TOOLS: Record<string, FunctionTool<any>> = {
  fs_list: fsList, fs_read: fsRead, fs_write: fsWrite,
  memory_recall: memoryRecall, memory_save: memorySave, memory_forget: memoryForget,
  shell_run: shellRun, browser: browserTool,
};

function loadCases(): Case[] {
  const dir = path.resolve("evals");
  return fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort().flatMap((f) =>
    fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Case));
}

function loadEnvLocal() {
  // Only fill missing keys; values are never printed.
  for (const f of [".env.local", ".env"]) {
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  }
}

function mockTransport(steps: any[]): Transport {
  let n = 0;
  return async function* () {
    const step = steps[n++] ?? { text: "(mock: hết kịch bản)" };
    const frames: Frame[] = step.calls
      ? [{ event: "", json: { choices: [{ delta: { tool_calls: step.calls.map((c: any, i: number) => ({ index: i, id: `c${n}_${i}`, function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })) }, finish_reason: "tool_calls" }] } }]
      : [{ event: "", json: { choices: [{ delta: { content: step.text }, finish_reason: "stop" }] } }];
    for (const f of frames) yield f;
  };
}

function realSetup() {
  loadEnvLocal();
  const endpoint = endpointFor(MODEL, resolveEndpoints(process.env));
  if (!endpoint) throw new Error(`no endpoint configured for ${MODEL} (set XAI_API_KEY)`);
  const transport: Transport = async function* (p, body, signal) {
    const res = await fetch(`${endpoint.base}${p}`, { method: "POST", signal, headers: { "Content-Type": "application/json", Authorization: `Bearer ${endpoint.key}` }, body: JSON.stringify(body) });
    if (!res.ok || !res.body) throw new Error(`upstream HTTP ${res.status}`);
    yield* sseFrames(res.body);
  };
  return { adapter: adapterFor(endpoint.style), transport };
}

function memoryAccess(store: MemoryStore, canWrite: boolean): MemoryAccess {
  return {
    canWrite,
    recall: (q, limit) => store.search(q, Math.min(20, Math.max(1, limit))).map((m) => ({ id: m.id, kind: m.kind, text: m.text, eventDate: m.eventDate })),
    save: (text, kind, eventDate) => {
      if (!canWrite) return { status: "skipped" };
      const r = store.add({ text, kind, eventDate, source: "chat" });
      return r.status === "skipped" ? { status: "skipped" } : { status: r.status, text: r.memory.text };
    },
    forget: (q) => (canWrite ? store.forget(q).map((m) => m.text) : []),
  };
}

type Outcome = { pass: boolean; why: string[] };

async function runAgentCase(c: Case, real: ReturnType<typeof realSetup> | null): Promise<Outcome> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sable-eval-"));
  const ws = path.join(root, "ws");
  fs.mkdirSync(ws);
  for (const [name, body] of Object.entries(c.files ?? {})) fs.writeFileSync(path.join(ws, name), String(body));
  const store = new MemoryStore(path.join(root, "mem"));
  for (const text of c.memories ?? []) store.add({ text, kind: "profile", source: "user" });
  const background = c.mode === "background";
  let asked = 0;
  const approve = c.approval === "none" ? undefined : async () => {
    asked += 1;
    if (c.approval === "approve") return true;
    if (c.approval === "expire") { await new Promise((r) => setTimeout(r, 20)); return false; } // expired = rejected
    return false;
  };
  const called: string[] = [];
  const outputs: string[] = [];
  // Record what the model asked for; approval gating (execute) still runs before `run`.
  const tools = (c.tools as string[]).map((n): FunctionTool<any> => {
    const t = TOOLS[n];
    return { ...t, run: async (args: any, tctx: ToolContext) => { const r = await t.run(args, tctx); outputs.push(r.output); return r; } };
  });
  const ctx: ToolContext = {
    workspaceDir: ws,
    signal: AbortSignal.timeout(REAL ? 120_000 : 10_000),
    mode: background ? "background" : "interactive",
    approve,
    memory: memoryAccess(store, !background),
  } as ToolContext;
  const assembled = assemble({ instructions: "Bạn là Sable, trợ lý cá nhân. Dùng công cụ khi cần; không đoán nội dung file.", memory: "", messages: [{ role: "user", content: c.prompt }], tools });
  const result = await runAgent(assembled, {
    adapter: real ? real.adapter : chatAdapter,
    transport: real ? real.transport : mockTransport(c.mock ?? []),
    tools, ctx, maxSteps: 6,
    opts: { model: REAL ? MODEL : "mock", effort: "low", maxTokens: 800 },
    emit: (e: any) => {
      if (e.event === "step" && e.data?.kind === "tool" && e.data.state === "run") {
        const t = tools.find((d) => { try { return e.data.label.startsWith(d.label({} as any).split(" · ")[0]); } catch { return false; } });
        if (t) called.push(t.name);
      }
    },
  });
  const x = c.expect ?? {};
  const why: string[] = [];
  const text = result.text;
  for (const n of x.called ?? []) if (!called.includes(n)) why.push(`expected call ${n}, got [${called}]`);
  for (const n of x.notCalled ?? []) if (called.includes(n)) why.push(`must not call ${n}`);
  if (typeof x.maxCalls === "number" && result.toolCalls > x.maxCalls) why.push(`calls ${result.toolCalls} > ${x.maxCalls}`);
  for (const s of x.textIncludes ?? []) if (!text.toLowerCase().includes(String(s).toLowerCase())) why.push(`text lacks "${s}"`);
  for (const s of x.textExcludes ?? []) if (text.includes(s)) why.push(`text has "${s}"`);
  for (const s of x.toolOutputExcludes ?? []) if (outputs.some((o) => o.includes(s))) why.push(`tool output has "${s}"`);
  for (const s of x.toolOutputIncludes ?? []) if (!outputs.some((o) => o.toLowerCase().includes(String(s).toLowerCase()))) why.push(`tool output lacks "${s}" (got ${JSON.stringify(outputs).slice(0,200)})`);
  if (typeof x.approvalsAsked === "number" && (x.approvalsAsked === 0 ? asked !== 0 : asked < x.approvalsAsked)) why.push(`approvals asked ${asked}, want ${x.approvalsAsked}`);
  if (x.file) {
    const p = path.join(ws, x.file.path);
    const exists = fs.existsSync(p);
    if (exists !== x.file.exists) why.push(`file ${x.file.path} exists=${exists}`);
    if (exists && x.file.contains && !fs.readFileSync(p, "utf8").includes(x.file.contains)) why.push("file content wrong");
  }
  const memText = JSON.stringify(store.list());
  for (const s of x.memoryExcludes ?? []) if (memText.includes(s)) why.push(`memory stored "${s}"`);
  if (typeof x.memoryCount === "number" && store.list().length !== x.memoryCount) why.push(`memory count ${store.list().length}`);
  fs.rmSync(root, { recursive: true, force: true });
  if (VERBOSE) console.log(`   [${c.id}] calls=[${called}] text=${JSON.stringify(text.slice(0, 160))}`);
  return { pass: why.length === 0, why };
}

function runPure(c: Case): Outcome {
  const x = c.expect ?? {};
  const why: string[] = [];
  if (c.cat === "redact") {
    const out = redactSecrets(c.input).text;
    for (const s of x.excludes ?? []) if (out.includes(s)) why.push(`not redacted: ${s}`);
    for (const s of x.includes ?? []) if (!out.includes(s)) why.push(`over-redacted: ${s}`);
  } else if (c.cat === "recall") {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sable-eval-"));
    const store = new MemoryStore(root);
    for (const text of c.memories) store.add({ text, kind: "profile", source: "user" });
    const top = store.search(c.query, 3)[0]?.text ?? "";
    if (!top.includes(x.top)) why.push(`top = "${top}"`);
    fs.rmSync(root, { recursive: true, force: true });
  } else if (c.cat === "schedule") {
    const from = Date.parse(c.from);
    const err = validateSchedule(c.schedule, c.tz, from);
    if (x.invalid) { if (!err) why.push("expected invalid"); }
    else if (err) why.push(`invalid: ${err}`);
    else {
      const next = nextRun(c.schedule, c.tz, from, c.anchor ? Date.parse(c.anchor) : from);
      const iso = next === null ? "null" : new Date(next).toISOString();
      if (iso !== x.next) why.push(`next ${iso} ≠ ${x.next}`);
    }
  } else if (c.cat === "profile") {
    const state = defaultState();
    const spec = spawnToolsFor(state, String(c.profileId));
    if (!spec) why.push(`unknown profile ${c.profileId}`);
    else {
      for (const t of x.includesTools ?? []) if (!spec.tools.includes(t)) why.push(`missing tool ${t}`);
      for (const t of x.excludesTools ?? []) if (spec.tools.includes(t)) why.push(`unexpected tool ${t}`);
    }
  } else why.push(`unknown cat ${c.cat}`);
  return { pass: why.length === 0, why };
}

async function runWebhook(c: Case): Promise<Outcome> {
  const x = c.expect ?? {};
  const why: string[] = [];
  const secret = String(c.secret || "test-webhook-secret-32chars!!");
  const body = JSON.stringify(c.body ?? makeEvent("ping", {}));
  const sig = c.sign ? `sha256=${signBody(secret, body)}` : String(c.signature || "");
  const wh = new WebhookChannel({ secret, ownerPeerId: "owner" });
  const out = await wh.handleInbound(body, sig);
  if (typeof x.status === "number" && out.status !== x.status) why.push(`status ${out.status} ≠ ${x.status}`);
  if (x.type && (out.body as any)?.type !== x.type) why.push(`type ${(out.body as any)?.type} ≠ ${x.type}`);
  return { pass: why.length === 0, why };
}

const cases = loadCases().filter((c) => !ONLY || c.id.includes(ONLY) || c.cat === ONLY);
const real = REAL ? realSetup() : null;
console.log(`Sable eval · ${REAL ? `real model ${MODEL}` : "mock model"} · ${cases.length} cases`);
const byCat = new Map<string, { pass: number; total: number }>();
const failures: string[] = [];
for (const c of cases) {
  let o: Outcome;
  try {
    if (["tool", "approval", "memory"].includes(c.cat)) o = await runAgentCase(c, real);
    else if (c.cat === "webhook") o = await runWebhook(c);
    else o = runPure(c);
  } catch (e) {
    o = { pass: false, why: [`threw: ${e instanceof Error ? e.message : e}`] };
  }
  const s = byCat.get(c.cat) ?? { pass: 0, total: 0 };
  s.total += 1; if (o.pass) s.pass += 1; byCat.set(c.cat, s);
  console.log(`${o.pass ? "PASS" : "FAIL"} ${c.cat.padEnd(8)} ${c.id}${o.pass ? "" : "  — " + o.why.join("; ")}`);
  if (!o.pass) failures.push(c.id);
}
let pass = 0, total = 0;
console.log("\nCategory   score");
for (const [cat, s] of byCat) { pass += s.pass; total += s.total; console.log(`${cat.padEnd(10)} ${s.pass}/${s.total}`); }
const pct = total ? Math.round((pass / total) * 1000) / 10 : 0;
console.log(`TOTAL      ${pass}/${total} (${pct}%)${failures.length ? " · failed: " + failures.join(", ") : ""}`);
process.exit((!REAL || STRICT) && pass < total ? 1 : 0);
