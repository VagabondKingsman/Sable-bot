import assert from "node:assert/strict";
import test from "node:test";
import { chatAdapter, responsesAdapter, type Body } from "./adapters.ts";
import { assemble } from "./assemble.ts";
import type { ClientEvent } from "./harness.ts";
import { runAgent, type Transport } from "./loop.ts";
import { sseFrames, type Frame } from "./sse.ts";
import type { FunctionTool, ToolContext } from "./tools/types.ts";

const ctx = (extra: Partial<ToolContext> = {}): ToolContext => ({
  workspaceDir: "/tmp/unused",
  signal: new AbortController().signal,
  mode: "interactive",
  ...extra,
});

const weather: FunctionTool<{ city: string }> = {
  kind: "function",
  name: "get_weather",
  description: "weather",
  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
  risk: "read",
  timeoutMs: 1_000,
  maxOutput: 1_000,
  label: (args) => `Thời tiết · ${args.city}`,
  run: async (args) => ({ ok: true, output: `${args.city}: 31C sunny` }),
};

/** Fake model: replays scripted frames per call and records request bodies. */
function scripted(steps: Frame[][]) {
  const bodies: Body[] = [];
  const transport: Transport = async function* (_path, body) {
    bodies.push(structuredClone(body));
    const frames = steps[bodies.length - 1];
    if (!frames) throw new Error("model called too many times");
    for (const frame of frames) yield frame;
  };
  return { transport, bodies };
}

const opts = { model: "m", effort: "high" as const, maxTokens: 100 };
const turn = (tools: FunctionTool[]) => assemble({ instructions: "I", memory: "", messages: [{ role: "user", content: "weather in Hanoi?" }], tools });

test("chat-style loop: tool_calls deltas → run tool → result fed back → answer", async () => {
  const { transport, bodies } = scripted([
    [
      { event: "", json: { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "get_weather", arguments: '{"ci' } }] } }] } },
      { event: "", json: { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ty":"Hanoi"}' } }] }, finish_reason: "tool_calls" }] } },
    ],
    [{ event: "", json: { choices: [{ delta: { content: "Hà Nội 31°C, nắng." }, finish_reason: "stop" }] } }],
  ]);
  const events: ClientEvent[] = [];
  const result = await runAgent(turn([weather]), { adapter: chatAdapter, transport, tools: [weather], ctx: ctx(), emit: (e) => events.push(e), opts });
  assert.equal(result.steps, 2);
  assert.equal(result.toolCalls, 1);
  assert.equal(result.text, "Hà Nội 31°C, nắng.");
  const second = bodies[1].messages as { role: string; content: string | null; tool_calls?: { id: string; function: { arguments: string } }[]; tool_call_id?: string }[];
  const assistant = second.at(-2)!;
  assert.equal(assistant.role, "assistant");
  assert.equal(assistant.tool_calls?.[0].id, "c1");
  assert.equal(assistant.tool_calls?.[0].function.arguments, '{"city":"Hanoi"}');
  assert.deepEqual(second.at(-1), { role: "tool", tool_call_id: "c1", content: "Hanoi: 31C sunny" });
  const steps = events.filter((e) => e.event === "step").map((e) => (e as { data: { kind: string; state?: string; label: string } }).data);
  assert.deepEqual(steps.map((s) => [s.kind, s.state, s.label]), [["tool", "run", "Thời tiết · Hanoi"], ["tool", "done", "Thời tiết · Hanoi"]]);
});

test("responses-style loop: function_call item → function_call_output via previous_response_id", async () => {
  const { transport, bodies } = scripted([
    [
      { event: "response.created", json: { type: "response.created", response: { id: "resp_1" } } },
      { event: "", json: { type: "response.output_item.done", item: { type: "function_call", call_id: "fc_1", name: "get_weather", arguments: '{"city":"Hue"}' } } },
    ],
    [{ event: "", json: { type: "response.output_text.delta", delta: "Huế 29°C." } }],
  ]);
  const result = await runAgent(turn([weather]), { adapter: responsesAdapter, transport, tools: [weather], ctx: ctx(), emit: () => undefined, opts });
  assert.equal(result.text, "Huế 29°C.");
  assert.equal(bodies[1].previous_response_id, "resp_1");
  assert.deepEqual(bodies[1].input, [{ type: "function_call_output", call_id: "fc_1", output: "Hue: 31C sunny" }]);
});

test("responses stateless mode replays items instead of chaining", async () => {
  const { transport, bodies } = scripted([
    [{ event: "", json: { type: "response.output_item.done", item: { type: "function_call", call_id: "fc_1", name: "get_weather", arguments: '{"city":"Hue"}' } } }],
    [{ event: "", json: { type: "response.output_text.delta", delta: "ok" } }],
  ]);
  await runAgent(turn([weather]), { adapter: responsesAdapter, transport, tools: [weather], ctx: ctx(), emit: () => undefined, opts: { ...opts, stateless: true } });
  const input = bodies[1].input as { type?: string; role?: string }[];
  assert.equal(input[0].role, "system");
  assert.deepEqual(input.slice(-2).map((item) => item.type), ["function_call", "function_call_output"]);
});

test("unknown tool and bad args become error results, not crashes", async () => {
  const { transport, bodies } = scripted([
    [
      { event: "", json: { choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "rm_rf", arguments: "{}" } }, { index: 1, id: "b", function: { name: "get_weather", arguments: "{oops" } }] } }] } },
    ],
    [{ event: "", json: { choices: [{ delta: { content: "xin lỗi" } }] } }],
  ]);
  await runAgent(turn([weather]), { adapter: chatAdapter, transport, tools: [weather], ctx: ctx(), emit: () => undefined, opts });
  const msgs = bodies[1].messages as { role: string; content: string }[];
  assert.match(msgs.at(-2)!.content, /^ERROR: unknown tool: rm_rf/);
  assert.match(msgs.at(-1)!.content, /^ERROR: invalid args/);
});

test("max-steps cap: last step forbids tools and the loop stops", async () => {
  const call = (id: string) => [{ event: "", json: { choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name: "get_weather", arguments: '{"city":"X"}' } }] } }] } }];
  const { transport, bodies } = scripted([call("1"), call("2"), call("3")]);
  const events: ClientEvent[] = [];
  const result = await runAgent(turn([weather]), { adapter: chatAdapter, transport, tools: [weather], ctx: ctx(), emit: (e) => events.push(e), opts, maxSteps: 3 });
  assert.equal(result.stopped, "max_steps");
  assert.equal(bodies.length, 3);
  assert.equal(bodies[2].tool_choice, "none");
  assert.equal(bodies[0].tool_choice, undefined);
  assert.ok(events.some((e) => e.event === "notice"));
});

test("text before and after a tool call is separated", async () => {
  const { transport } = scripted([
    [
      { event: "", json: { choices: [{ delta: { content: "Để mình xem." } }] } },
      { event: "", json: { choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name: "get_weather", arguments: '{"city":"A"}' } }] } }] } },
    ],
    [{ event: "", json: { choices: [{ delta: { content: "Xong." } }] } }],
  ]);
  const result = await runAgent(turn([weather]), { adapter: chatAdapter, transport, tools: [weather], ctx: ctx(), emit: () => undefined, opts });
  assert.equal(result.text, "Để mình xem.\n\nXong.");
});

test("sseFrames parses event/data lines and throws on error frames", async () => {
  const enc = new TextEncoder();
  const stream = (text: string) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(text.slice(0, 7)));
        c.enqueue(enc.encode(text.slice(7)));
        c.close();
      },
    });
  const frames: Frame[] = [];
  for await (const f of sseFrames(stream('event: a\ndata: {"x":1}\n\ndata: [DONE]\n\n'))) frames.push(f);
  assert.deepEqual(frames, [{ event: "a", json: { x: 1 } }]);
  await assert.rejects(async () => {
    for await (const _ of sseFrames(stream('data: {"error":{"message":"quota"}}\n\n'))) void _;
  }, /quota/);
});

// --- Regression: e2e re-test 2026-11-03 ---

test("regression: chat parser joins index-less argument chunks and repeated names", () => {
  const noIndex = chatAdapter.parser();
  noIndex.push("", { choices: [{ delta: { tool_calls: [{ id: "x1", function: { name: "get_weather", arguments: '{"city":' } }] } }] });
  noIndex.push("", { choices: [{ delta: { tool_calls: [{ function: { arguments: '"Hanoi"}' } }] } }] });
  noIndex.push("", { choices: [{ delta: { tool_calls: [{ id: "x2", function: { name: "get_weather", arguments: '{"city":"Hue"}' } }] } }] });
  assert.deepEqual(noIndex.result().calls, [
    { id: "x1", name: "get_weather", args: '{"city":"Hanoi"}' },
    { id: "x2", name: "get_weather", args: '{"city":"Hue"}' },
  ]);
  const repeated = chatAdapter.parser();
  repeated.push("", { choices: [{ delta: { tool_calls: [{ index: 0, id: "r", function: { name: "get_weather", arguments: '{"city":' } }] } }] });
  repeated.push("", { choices: [{ delta: { tool_calls: [{ index: 0, id: "r", function: { name: "get_weather", arguments: '"Hanoi"}' } }] } }] });
  assert.deepEqual(repeated.result().calls, [{ id: "r", name: "get_weather", args: '{"city":"Hanoi"}' }]);
});

test("regression: trace step ids stay unique when a provider reuses call ids across steps", async () => {
  const call = (id: string) => [
    { event: "", json: { choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name: "get_weather", arguments: '{"city":"Hanoi"}' } }] }, finish_reason: "tool_calls" }] } },
  ];
  const { transport } = scripted([call("call_0"), call("call_0"), [{ event: "", json: { choices: [{ delta: { content: "ok" } }] } }]]);
  const events: ClientEvent[] = [];
  await runAgent(turn([weather]), { adapter: chatAdapter, transport, tools: [weather], ctx: ctx(), emit: (e) => events.push(e), opts });
  const ids = new Set(events.filter((e) => e.event === "step").map((e) => (e as { data: { id: string } }).data.id));
  assert.equal(ids.size, 2);
});

test("regression: chat parser fallback ids differ between steps when the provider sends none", () => {
  const a = chatAdapter.parser();
  a.push("", { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "get_weather", arguments: "{}" } }] } }] });
  const b = chatAdapter.parser();
  b.push("", { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "get_weather", arguments: "{}" } }] } }] });
  assert.notEqual(a.result().calls[0].id, b.result().calls[0].id);
});
