/**
 * The agent loop: model → tool calls → run handlers → feed results → model,
 * capped at maxSteps. Provider-agnostic (adapter + transport injected) so the
 * same loop can later serve background jobs and routines.
 */
import type { Assembled } from "./assemble.ts";
import type { Body, CallOpts, ProviderAdapter, StepOutcome } from "./adapters.ts";
import type { ClientEvent } from "./harness.ts";
import type { Frame } from "./sse.ts";
import { execute } from "./tools/execute.ts";
import { parseArgs } from "./tools/validate.ts";
import type { FunctionTool, ToolCall, ToolContext, ToolResult } from "./tools/types.ts";

export const DEFAULT_MAX_STEPS = 6;
const PARALLEL = 4;

export type Transport = (path: string, body: Body, signal: AbortSignal) => AsyncIterable<Frame>;

export type LoopDeps = {
  adapter: ProviderAdapter;
  transport: Transport;
  /** Function tools live this turn (already filtered by flags + provider). */
  tools: FunctionTool[];
  ctx: ToolContext;
  emit: (event: ClientEvent) => void;
  opts: CallOpts;
  maxSteps?: number;
  /** W7: messages from the owner that arrived mid-turn, taken at a safe point (between steps). */
  steer?: () => string[];
};

/** Append owner messages to the next model call (Responses `input` or chat `messages`). */
export function appendUserMessages(body: Body, texts: string[]): Body {
  if (!texts.length) return body;
  const items = texts.map((content) => ({ role: "user", content }));
  if (Array.isArray(body.messages)) return { ...body, messages: [...body.messages, ...items] };
  if (Array.isArray(body.input)) return { ...body, input: [...body.input, ...items] };
  return body;
}

export type RunResult = {
  text: string;
  steps: number;
  toolCalls: number;
  stopped?: "max_steps";
};

function labelFor(def: FunctionTool | undefined, call: ToolCall) {
  if (!def) return `Công cụ lạ · ${call.name}`;
  const parsed = parseArgs(call.args, { ...def.parameters, required: [], additionalProperties: undefined });
  try {
    return parsed.ok ? def.label(parsed.value) : def.name;
  } catch {
    return def.name;
  }
}

async function runOne(call: ToolCall, deps: LoopDeps, step: number): Promise<ToolResult> {
  const def = deps.tools.find((tool) => tool.name === call.name);
  // Step number in the id: providers may reuse call ids across steps (e.g. "call_0").
  const stepId = `tool-${step}-${call.id}`;
  const label = labelFor(def, call);
  const started = Date.now();
  deps.emit({ event: "step", data: { id: stepId, kind: "tool", label, state: "run", tool: call.name, at: started } });
  const result: ToolResult = def
    ? await execute(def, call.args, { ...deps.ctx, stepId })
    : { ok: false, output: `unknown tool: ${call.name}. Available: ${deps.tools.map((tool) => tool.name).join(", ") || "none"}` };
  const ms = Date.now() - started;
  // Keep a short clip of tool output on success too (shell jail markers, fetch status, ...).
  const detail = [`${result.ok ? "ok" : "lỗi"} · ${ms} ms`, result.detail ?? "", result.output ?? ""].filter(Boolean).join("\n").slice(0, 2_000);
  deps.emit({
    event: "step",
    data: { id: stepId, kind: "tool", label, detail, state: "done", tool: call.name, ms, sources: result.sources?.length ? result.sources.slice(0, 8) : undefined },
  });
  return result;
}

async function runCalls(calls: ToolCall[], deps: LoopDeps, step: number): Promise<ToolResult[]> {
  const allRead = calls.every((call) => deps.tools.find((tool) => tool.name === call.name)?.risk === "read");
  if (!allRead) {
    const out: ToolResult[] = [];
    for (const call of calls) {
      if (deps.ctx.signal.aborted) out.push({ ok: false, output: "cancelled" });
      else out.push(await runOne(call, deps, step));
    }
    return out;
  }
  const out: ToolResult[] = [];
  for (let index = 0; index < calls.length; index += PARALLEL) {
    out.push(...(await Promise.all(calls.slice(index, index + PARALLEL).map((call) => runOne(call, deps, step)))));
  }
  return out;
}

export async function runAgent(assembled: Assembled, deps: LoopDeps): Promise<RunResult> {
  const maxSteps = Math.max(1, deps.maxSteps ?? DEFAULT_MAX_STEPS);
  let body = deps.adapter.buildBody(assembled, deps.opts);
  let text = "";
  let breakBefore = false;
  let toolCalls = 0;
  const emit = (event: ClientEvent) => {
    if (event.event === "delta") {
      if (breakBefore && text && !text.endsWith("\n")) {
        deps.emit({ event: "delta", data: { text: "\n\n" } });
        text += "\n\n";
      }
      breakBefore = false;
      text += event.data.text;
    }
    deps.emit(event);
  };

  for (let step = 0; step < maxSteps; step += 1) {
    if (deps.ctx.signal.aborted) break;
    const last = step === maxSteps - 1;
    // Final step: tools stay declared (history references them) but may not be called.
    const request = last && step > 0 && body.tools ? { ...body, tool_choice: "none" } : body;
    const parser = deps.adapter.parser();
    for await (const frame of deps.transport(deps.adapter.path, request, deps.ctx.signal)) {
      for (const event of parser.push(frame.event, frame.json)) emit(event);
    }
    const outcome: StepOutcome = parser.result();
    if (!outcome.calls.length) return { text, steps: step + 1, toolCalls };
    if (last) {
      deps.emit({ event: "notice", data: { text: `Dừng sau ${maxSteps} bước công cụ. Gửi "tiếp tục" để làm tiếp.` } });
      return { text, steps: step + 1, toolCalls, stopped: "max_steps" };
    }
    deps.emit({ event: "status", data: { text: outcome.calls.length > 1 ? `Đang chạy ${outcome.calls.length} công cụ` : "Đang chạy công cụ" } });
    const results = await runCalls(outcome.calls, deps, step);
    toolCalls += outcome.calls.length;
    breakBefore = true;
    body = deps.adapter.appendToolResults(body, outcome, results, deps.opts);
    // Safe point: tool results are in; deliver anything the owner sent meanwhile.
    const steered = deps.ctx.signal.aborted ? [] : (deps.steer?.() ?? []);
    if (steered.length) body = appendUserMessages(body, steered);
    // The next model call can stay silent for minutes (hidden reasoning); don't leave
    // "Đang chạy công cụ" on screen after the tools have finished.
    if (!deps.ctx.signal.aborted) deps.emit({ event: "status", data: { text: "Đang suy nghĩ" } });
  }
  return { text, steps: maxSteps, toolCalls };
}
