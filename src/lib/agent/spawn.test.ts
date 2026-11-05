import assert from "node:assert/strict";
import test from "node:test";
import { chatAdapter } from "./adapters.ts";
import type { ClientEvent } from "./harness.ts";
import type { Transport } from "./loop.ts";
import { runAgent } from "./loop.ts";
import { assemble } from "./assemble.ts";
import { createSpawner } from "./spawn.ts";
import { spawnAgent } from "./tools/spawn.ts";
import type { Frame } from "./sse.ts";
import type { FunctionTool, ToolContext } from "./tools/types.ts";

const opts = { model: "m", effort: "low" as const, maxTokens: 100 };
const call = (name: string, args: object, id = "c1"): Frame[] => [
  { event: "", json: { choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }] } },
];
const say = (text: string): Frame[] => [{ event: "", json: { choices: [{ delta: { content: text }, finish_reason: "stop" }] } }];
function scripted(steps: Frame[][]) {
  const seen: unknown[] = [];
  const transport: Transport = async function* (_p, body) {
    seen.push(structuredClone(body));
    const frames = steps[seen.length - 1];
    if (!frames) throw new Error("model called too many times");
    for (const f of frames) yield f;
  };
  return { transport, seen };
}
let writes = 0;
const fsRead: FunctionTool<{ path: string }> = { kind: "function", name: "fs_read", description: "r", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, risk: "read", timeoutMs: 1000, maxOutput: 1000, label: (a) => `fs_read · ${a.path}`, run: async () => ({ ok: true, output: "file body" }) };
const fsWrite: FunctionTool<{ path: string }> = { kind: "function", name: "fs_write", description: "w", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, risk: "write", needsApproval: true, timeoutMs: 1000, maxOutput: 1000, label: (a) => `fs_write · ${a.path}`, run: async () => { writes++; return { ok: true, output: "wrote" }; } };
const limits = { maxChildren: 2, maxSteps: 4, timeoutMs: 5000 };
const ctx = (extra: Partial<ToolContext> = {}): ToolContext => ({ workspaceDir: "/tmp/x", signal: new AbortController().signal, mode: "background", stepId: "tool-0-p1", ...extra });

test("writer child: write goes through parent approver (prefixed), rejection respected, steps nested", async () => {
  writes = 0;
  const { transport, seen } = scripted([call("fs_write", { path: "a.txt" }), say("Không ghi được, đã báo cáo.")]);
  const events: ClientEvent[] = [];
  const asks: string[] = [];
  const spawn = createSpawner({ adapter: chatAdapter, transport, opts, functions: [fsRead, fsWrite, spawnAgent] }, [fsRead, fsWrite, spawnAgent], (e) => events.push(e), limits);
  const res = await spawn({ task: "write a.txt", profile: "writer" }, ctx({ approve: async (ask) => { asks.push(ask.summary); return false; } }));
  assert.equal(writes, 0);
  assert.match(asks[0], /^\[sub-agent writer\] fs_write · a\.txt/);
  assert.ok(res.ok);
  assert.match(res.output, /SUB-AGENT REPORT[\s\S]*Không ghi được/);
  const steps = events.filter((e) => e.event === "step").map((e) => (e as { data: { id: string; parent?: string } }).data);
  assert.ok(steps.length >= 2 && steps.every((s) => s.parent === "tool-0-p1" && s.id.startsWith("tool-0-p1~")));
  const tools = ((seen[0] as { tools?: { function: { name: string } }[] }).tools ?? []).map((t) => t.function.name);
  assert.deepEqual(tools.sort(), ["fs_read", "fs_write"], "child never gets spawn_agent");
});

test("research profile cannot write even if parent can", async () => {
  writes = 0;
  const { transport, seen } = scripted([call("fs_write", { path: "a.txt" }), say("ok")]);
  const spawn = createSpawner({ adapter: chatAdapter, transport, opts, functions: [fsRead, fsWrite] }, [fsRead, fsWrite], () => {}, limits);
  const res = await spawn({ task: "t", profile: "research" }, ctx({ approve: async () => true }));
  assert.equal(writes, 0);
  const tools = ((seen[0] as { tools?: { function: { name: string } }[] }).tools ?? []).map((t) => t.function.name);
  assert.deepEqual(tools, ["fs_read"]);
  assert.ok(res.output.includes("ok"));
});

test("approved write in child runs once; no approver → refused", async () => {
  writes = 0;
  let s = scripted([call("fs_write", { path: "a.txt" }), say("done")]);
  let spawn = createSpawner({ adapter: chatAdapter, transport: s.transport, opts, functions: [fsWrite] }, [fsWrite], () => {}, limits);
  await spawn({ task: "t", profile: "writer" }, ctx({ approve: async () => true }));
  assert.equal(writes, 1);
  s = scripted([call("fs_write", { path: "a.txt" }), say("done")]);
  spawn = createSpawner({ adapter: chatAdapter, transport: s.transport, opts, functions: [fsWrite] }, [fsWrite], () => {}, limits);
  await spawn({ task: "t", profile: "writer" }, ctx());
  assert.equal(writes, 1);
});

test("max children per turn and depth limit", async () => {
  const s = scripted([say("a"), say("b"), say("c")]);
  const spawn = createSpawner({ adapter: chatAdapter, transport: s.transport, opts, functions: [] }, [], () => {}, { ...limits, maxChildren: 2 });
  assert.ok((await spawn({ task: "1", profile: "research" }, ctx())).ok);
  assert.ok((await spawn({ task: "2", profile: "research" }, ctx())).ok);
  const third = await spawn({ task: "3", profile: "research" }, ctx());
  assert.equal(third.ok, false);
  assert.match(third.output, /at most 2/);
  // a ctx without spawn (what a child gets) refuses
  const refused = await spawnAgent.run({ task: "x", profile: "coder" }, ctx());
  assert.equal(refused.ok, false);
});

test("child time budget aborts a hanging model", async () => {
  const transport: Transport = async function* (_p, _b, signal) {
    await new Promise((_, rej) => signal.addEventListener("abort", () => rej(new Error("aborted"))));
    yield { event: "", json: {} };
  };
  const spawn = createSpawner({ adapter: chatAdapter, transport, opts, functions: [] }, [], () => {}, { ...limits, timeoutMs: 200 });
  const t0 = Date.now();
  const res = await spawn({ task: "slow", profile: "research" }, ctx());
  assert.equal(res.ok, false);
  assert.ok(Date.now() - t0 < 2000);
  assert.match(res.output, /timed out|time budget/);
});

test("parent loop → spawn_agent → nested trace + report fed back", async () => {
  const parentScript = scripted([call("spawn_agent", { task: "read notes", profile: "research" }, "p1"), say("Tóm tắt xong.")]);
  const childScript = scripted([call("fs_read", { path: "n.md" }), say("notes say hi")]);
  const events: ClientEvent[] = [];
  const emit = (e: ClientEvent) => events.push(e);
  const context = ctx({ mode: "interactive" });
  context.spawn = createSpawner({ adapter: chatAdapter, transport: childScript.transport, opts, functions: [fsRead] }, [fsRead], emit, limits);
  const out = await runAgent(assemble({ instructions: "", memory: "", messages: [{ role: "user", content: "go" }], tools: [spawnAgent, fsRead] }), { adapter: chatAdapter, transport: parentScript.transport, tools: [spawnAgent, fsRead], ctx: context, emit, opts });
  assert.equal(out.text, "Tóm tắt xong.");
  const fed = JSON.stringify(parentScript.seen[1]);
  assert.match(fed, /SUB-AGENT REPORT[^"]*research/);
  assert.match(fed, /notes say hi/);
  const nested = events.filter((e) => e.event === "step" && (e.data as { parent?: string }).parent === "tool-0-p1");
  assert.ok(nested.some((e) => (e.data as { label: string }).label.includes("fs_read · n.md")));
});
