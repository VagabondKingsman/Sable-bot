import assert from "node:assert/strict";
import test from "node:test";
import { effortFor, interpretChatChunk, interpretUpstream, mergeTrace, parseChatRequest } from "./harness.ts";
import type { TraceStep } from "./types.ts";

test("duplicate searches collapse onto one timeline row", () => {
  let steps: TraceStep[] = [];
  const add = (step: (typeof steps)[number]) => {
    steps = mergeTrace(steps, step);
  };
  add({ id: "a", kind: "web", label: "Đang tìm trên web", state: "run" });
  add({ id: "b", kind: "web", label: "Web · sable bot", state: "done" });
  add({ id: "c", kind: "web", label: "Web · sable bot", state: "done" });
  add({ id: "d", kind: "web", label: "Đã tìm trên web", state: "done" });
  add({ id: "e", kind: "web", label: "Web · site:github.com/morluto/rea", state: "done" });
  assert.deepEqual(
    steps.map((step) => step.label),
    ["Web · sable bot", "Web · site:github.com/morluto/rea"],
  );
});

test("parse keeps the last user turn and reports a clip", () => {
  const messages = [
    ...Array.from({ length: 28 }, (_, index) => ({
      role: (index % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `tin ${index}`,
    })),
    { role: "assistant" as const, content: "gần cuối" },
    { role: "user" as const, content: "x".repeat(20_000) },
  ];
  const parsed = parseChatRequest({ model: "grok-4.7", effort: "low", messages, tools: { web: true } });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.request.messages.length, 24);
  assert.equal(parsed.request.messages.at(-1)?.role, "user");
  assert.equal(parsed.request.messages.at(-1)?.content.length, 20_000);
  assert.ok(parsed.notices.some((notice) => notice.includes("24")));
  assert.equal(parsed.request.tools.web, true);
  assert.equal(parsed.request.tools.image, false);
});

test("grok-4.5 maps xhigh to high", () => {
  assert.deepEqual(effortFor("grok-4.5", "xhigh").effort, "high");
  assert.equal(effortFor("grok-4.7", "xhigh").effort, "xhigh");
});

test("text deltas stream and code results become a step", () => {
  const delta = interpretUpstream("response.output_text.delta", {
    type: "response.output_text.delta",
    delta: "pong",
  });
  assert.equal(delta[0]?.event, "delta");

  const done = interpretUpstream("response.output_item.done", {
    type: "response.output_item.done",
    item: {
      id: "ci_1",
      type: "code_interpreter_call",
      code: "print(6*7)",
      outputs: [{ logs: JSON.stringify({ stdout: "42\n", stderr: "" }) }],
    },
  });
  const step = done.find((event) => event.event === "step");
  assert.ok(step && step.event === "step" && step.data.detail?.includes("42"));

  const search = interpretUpstream("response.output_item.done", {
    type: "response.output_item.done",
    item: {
      id: "ws_1",
      type: "web_search_call",
      action: { query: "xAI", sources: [{ url: "https://x.ai/" }] },
    },
  });
  const doneStep = search.find((event) => event.event === "step");
  assert.ok(doneStep && doneStep.event === "step" && doneStep.data.state === "done" && doneStep.data.sources?.[0] === "https://x.ai/");

  const started = interpretUpstream("response.output_item.added", {
    type: "response.output_item.added",
    item: { id: "ws_1", type: "web_search_call" },
  });
  const run = started.find((event) => event.event === "step");
  assert.ok(run && run.event === "step" && run.data.state === "run" && run.data.id === "ws_1");

  const thought = interpretUpstream("response.reasoning_summary_text.delta", {
    type: "response.reasoning_summary_text.delta",
    delta: "đang đọc",
  });
  assert.equal(thought[0]?.event, "thought");
});

test("any well-formed model id parses, not only grok-*", () => {
  const messages = [{ role: "user" as const, content: "hi" }];
  assert.equal(parseChatRequest({ model: "deepseek-chat", messages }).ok, true);
  assert.equal(parseChatRequest({ model: "openai/gpt-4o", messages }).ok, true);
  assert.equal(parseChatRequest({ model: "bad model!", messages }).ok, false);
});

test("chat/completions chunks map to delta and thought", () => {
  assert.deepEqual(interpretChatChunk({ choices: [{ delta: { reasoning_content: "hm", content: "Xin chào" } }] }), [
    { event: "thought", data: { text: "hm" } },
    { event: "delta", data: { text: "Xin chào" } },
  ]);
  assert.deepEqual(interpretChatChunk({ choices: [{ delta: {} }] }), []);
});
