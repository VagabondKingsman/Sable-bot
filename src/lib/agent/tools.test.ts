import assert from "node:assert/strict";
import test from "node:test";
import { assemble, clipHistory, toolCatalog } from "./assemble.ts";
import { chatAdapter, responsesAdapter } from "./adapters.ts";
import { createApprovals } from "./tools/approvals.ts";
import { execute } from "./tools/execute.ts";
import { toChatTools, toResponsesTools } from "./tools/format.ts";
import { builtinTools, createRegistry, selectTools, skipNotices } from "./tools/registry.ts";
import type { FunctionTool, ToolContext } from "./tools/types.ts";
import { parseArgs } from "./tools/validate.ts";

const ALL = { web: true, x: true, code: true, image: true, files: true, fetch: true };
const ctx = (extra: Partial<ToolContext> = {}): ToolContext => ({
  workspaceDir: "/tmp/sable-test-unused",
  signal: new AbortController().signal,
  mode: "interactive",
  ...extra,
});

test("registry rejects bad names, duplicates and unapproved write tools", () => {
  const ok: FunctionTool = {
    kind: "function",
    name: "echo",
    description: "d",
    parameters: { type: "object", properties: {} },
    risk: "read",
    timeoutMs: 100,
    maxOutput: 100,
    label: () => "echo",
    run: async () => ({ ok: true, output: "x" }),
  };
  assert.throws(() => createRegistry([{ ...ok, name: "Bad-Name" }]), /bad tool name/);
  assert.throws(() => createRegistry([ok, ok]), /duplicate/);
  assert.throws(() => createRegistry([{ ...ok, name: "danger", risk: "write" }]), /approval/);
  assert.equal(createRegistry([ok]).get("echo")?.name, "echo");
});

test("builtin registry: xAI gets server + function tools, chat gets function tools only", () => {
  const registry = createRegistry(builtinTools());
  const xai = selectTools(registry, ALL, { serverTools: true, functionTools: true });
  assert.deepEqual(
    xai.active.map((tool) => tool.name),
    ["web_search", "x_search", "code_interpreter", "image_generation", "fs_list", "fs_read", "fs_write", "http_fetch"],
  );
  assert.deepEqual(xai.skipped, []);
  const chat = selectTools(registry, ALL, { serverTools: false, functionTools: true });
  assert.deepEqual(chat.active.map((tool) => tool.name), ["fs_list", "fs_read", "fs_write", "http_fetch"]);
  // image_generation (Imagine) is never advertised to a non-xAI provider.
  assert.ok(chat.skipped.includes("image_generation"));
  assert.ok(!chat.active.some((tool) => tool.name === "image_generation"));
  const off = selectTools(registry, { web: false, x: false, code: false, image: false }, { serverTools: true, functionTools: true });
  assert.equal(off.active.length, 0);
  const killed = selectTools(registry, ALL, { serverTools: false, functionTools: false });
  assert.equal(killed.active.length, 0);
});

test("adapters render one registry to xAI responses and chat formats", () => {
  const registry = createRegistry(builtinTools());
  const defs = selectTools(registry, { web: true, x: false, code: true, image: false, files: true, fetch: false }, { serverTools: true, functionTools: true }).active;
  const responses = toResponsesTools(defs);
  assert.deepEqual(responses[0], { type: "web_search" });
  assert.deepEqual(responses[1], { type: "code_interpreter" });
  const fsRead = responses.find((tool) => "name" in tool && tool.name === "fs_read") as { type: string; name: string; parameters: { required?: string[] } };
  assert.equal(fsRead.type, "function");
  assert.deepEqual(fsRead.parameters.required, ["path"]);
  const chat = toChatTools(defs);
  assert.equal(chat.length, 3);
  assert.ok(chat.every((tool) => tool.type === "function" && tool.function.name.startsWith("fs_")));
  assert.ok(!chat.some((tool) => (tool.function.name as string) === "web_search"));

  const assembled = assemble({ instructions: "I", memory: "", messages: [{ role: "user", content: "hi" }], tools: defs });
  const rb = responsesAdapter.buildBody(assembled, { model: "grok-4.7", effort: "high", maxTokens: 100, codeOutputs: true });
  assert.equal((rb.tools as unknown[]).length, 5);
  assert.deepEqual(rb.include, ["code_interpreter_call.outputs"]);
  const cb = chatAdapter.buildBody(assembled, { model: "deepseek-chat", effort: "high", maxTokens: 100 });
  assert.equal((cb.tools as unknown[]).length, 3);
  assert.equal((cb.messages as { role: string }[])[0].role, "system");
  assert.equal(cb.max_tokens, 100);
});

test("parseArgs validates the schema subset", () => {
  const schema = {
    type: "object" as const,
    properties: { path: { type: "string" as const, maxLength: 5 }, n: { type: "integer" as const, minimum: 1 }, m: { type: "string" as const, enum: ["a", "b"] } },
    required: ["path"],
    additionalProperties: false as const,
  };
  assert.equal(parseArgs('{"path":"a"}', schema).ok, true);
  assert.equal(parseArgs("not json", schema).ok, false);
  assert.equal(parseArgs("{}", schema).ok, false);
  assert.equal(parseArgs('{"path":"toolong"}', schema).ok, false);
  assert.equal(parseArgs('{"path":"a","n":1.5}', schema).ok, false);
  assert.equal(parseArgs('{"path":"a","m":"c"}', schema).ok, false);
  assert.equal(parseArgs('{"path":"a","zzz":1}', schema).ok, false);
});

const slow: FunctionTool = {
  kind: "function",
  name: "slow",
  description: "d",
  parameters: { type: "object", properties: {} },
  risk: "read",
  timeoutMs: 50,
  maxOutput: 10,
  label: () => "slow",
  run: (_args, c) => new Promise((resolve) => setTimeout(() => resolve({ ok: true, output: "late" }), c.signal.aborted ? 0 : 500)),
};

test("execute enforces per-tool timeout and output clipping", async () => {
  const timed = await execute(slow, "{}", ctx());
  assert.equal(timed.ok, false);
  assert.match(timed.output, /timed out after 50 ms/);
  const big = await execute({ ...slow, timeoutMs: 1_000, run: async () => ({ ok: true, output: "x".repeat(100) }) }, "{}", ctx());
  assert.ok(big.output.startsWith("x".repeat(10)));
  assert.match(big.output, /cắt bớt 90/);
  const thrown = await execute({ ...slow, timeoutMs: 1_000, run: async () => { throw new Error("boom"); } }, "{}", ctx());
  assert.equal(thrown.output, "tool error: boom");
});

test("write tools never run without approval", async () => {
  let ran = 0;
  const write: FunctionTool = { ...slow, name: "w", risk: "write", needsApproval: true, timeoutMs: 1_000, run: async () => { ran += 1; return { ok: true, output: "wrote" }; } };
  assert.equal((await execute(write, "{}", ctx())).ok, false); // no approver
  // Background jobs get no auto-approver: without one the write is refused, and the
  // runner's approver only resolves on a user click (see jobs.test.ts).
  assert.equal((await execute(write, "{}", ctx({ mode: "background" }))).ok, false);
  assert.equal((await execute(write, "{}", ctx({ mode: "background", approve: async () => false }))).ok, false);
  const rejected = await execute(write, "{}", ctx({ approve: async () => false }));
  assert.match(rejected.output, /rejected/);
  assert.equal(ran, 0);
  const approved = await execute(write, "{}", ctx({ approve: async () => true }));
  assert.equal(approved.output, "wrote");
  assert.equal(ran, 1);
});

test("approval gate: decide resolves, unknown ids 404, timeout expires", async () => {
  const events: { event: string; data: { state?: string; id?: string } }[] = [];
  const gate = createApprovals(50, () => "a1");
  const waiting = gate.request({ tool: "fs_write", summary: "Ghi x" }, (event) => events.push(event as never), new AbortController().signal);
  assert.equal(gate.pending(), 1);
  assert.equal(gate.decide("nope", true), false);
  assert.equal(gate.decide("a1", true), true);
  assert.equal(await waiting, true);
  assert.deepEqual(events.filter((e) => e.event === "approval").map((e) => e.data.state), ["pending", "approved"]);
  const expired = await createApprovals(20).request({ tool: "t", summary: "s" }, () => undefined, new AbortController().signal);
  assert.equal(expired, false);
});

test("assemble: identity + tools + memory blocks, budgets reported, stable", () => {
  const registry = createRegistry(builtinTools());
  const tools = selectTools(registry, { web: false, x: false, code: false, image: false, files: true, fetch: true }, { serverTools: false, functionTools: true }).active;
  const a = assemble({ instructions: "x".repeat(20_000), memory: "likes tea", messages: [], tools });
  assert.equal(a.report[0].name, "identity");
  assert.equal(a.report[0].clipped, true);
  assert.equal(a.report[0].used, 12_000);
  assert.match(a.system, /Tools live this turn: fs_list, fs_read, fs_write, http_fetch\./);
  assert.match(a.system, /fs_write waits for the user to approve/);
  assert.match(a.system, /Ghi nhớ do người dùng tự viết:\nlikes tea/);
  assert.equal(assemble({ instructions: "I", memory: "", messages: [], tools }).system, assemble({ instructions: "I", memory: "", messages: [], tools }).system);
  assert.equal(toolCatalog([]), "No tools this turn. Answer from the thread.");
  const dated = assemble({ instructions: "I", memory: "", messages: [], tools: [], now: new Date("2026-11-03T05:00:00Z") });
  assert.match(dated.system, /Asia\/Saigon/);
});

test("clipHistory keeps the last 24 and clips long turns", () => {
  const raw = [...Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `m${i}` })), { role: "user", content: "y".repeat(60_000) }, { role: "bad", content: "z" }, null];
  const { messages, notices } = clipHistory(raw);
  assert.equal(messages.length, 24);
  assert.equal(messages.at(-1)?.content.length, 48_000);
  assert.equal(notices.length, 2);
});

test("regression: SABLE_TOOLS=0 notice names the kill switch, not the provider", () => {
  const registry = createRegistry(builtinTools());
  const flags = { web: true, x: false, code: false, image: false, files: true, fetch: true };
  const off = selectTools(registry, flags, { serverTools: false, functionTools: false });
  const notes = skipNotices(off, "DeepSeek (deepseek-chat)", false);
  assert.equal(notes.length, 2);
  assert.match(notes[0], /SABLE_TOOLS=0/);
  assert.match(notes[0], /fs_list/);
  assert.doesNotMatch(notes[0], /xAI/);
  assert.match(notes[1], /web_search/);
  assert.doesNotMatch(notes[1], /fs_list/);
  const on = selectTools(registry, flags, { serverTools: false, functionTools: true });
  assert.deepEqual(skipNotices(on, "X", true).length, 1);
  assert.deepEqual(skipNotices(selectTools(registry, flags, { serverTools: true, functionTools: true }), "X", true), []);
});
