/**
 * Provider adapters: one interface, two wire styles (ApiStyle).
 *  - responses: xAI /v1/responses (server tools + function tools)
 *  - chat:      OpenAI / DeepSeek /v1/chat/completions (function tools)
 * Pure: no fetch, no env. The loop (loop.ts) drives them.
 */
import type { Assembled } from "./assemble.ts";
import { interpretChatChunk, interpretUpstream, type ClientEvent } from "./harness.ts";
import type { ApiStyle } from "./provider.ts";
import type { Effort } from "./types.ts";
import { resultText, toChatTools, toResponsesTools } from "./tools/format.ts";
import type { ToolCall, ToolResult } from "./tools/types.ts";

export type Body = Record<string, unknown>;

export type CallOpts = {
  model: string;
  effort: Effort;
  maxTokens: number;
  /** Ask xAI to include code_interpreter outputs. */
  codeOutputs?: boolean;
  /** DeepSeek thinking mode wants reasoning_content echoed back on tool turns. */
  echoReasoning?: boolean;
  /** Responses: replay items instead of chaining previous_response_id. */
  stateless?: boolean;
};

export type StepOutcome = {
  text: string;
  reasoning: string;
  calls: ToolCall[];
  responseId?: string;
  finish?: string;
};

export interface StepParser {
  push(eventName: string, json: unknown): ClientEvent[];
  result(): StepOutcome;
}

export interface ProviderAdapter {
  style: ApiStyle;
  path: string;
  buildBody(assembled: Assembled, opts: CallOpts): Body;
  parser(): StepParser;
  appendToolResults(body: Body, outcome: StepOutcome, results: ToolResult[], opts: CallOpts): Body;
}

type FnItem = { type?: string; call_id?: string; id?: string; name?: string; arguments?: string };

export const responsesAdapter: ProviderAdapter = {
  style: "responses",
  path: "/v1/responses",
  buildBody(assembled, opts) {
    const body: Body = {
      model: opts.model,
      stream: true,
      max_output_tokens: opts.maxTokens,
      reasoning: { effort: opts.effort },
      input: [{ role: "system", content: assembled.system }, ...assembled.messages],
    };
    const tools = toResponsesTools(assembled.tools);
    if (tools.length) body.tools = tools;
    if (opts.codeOutputs) body.include = ["code_interpreter_call.outputs"];
    return body;
  },
  parser() {
    let text = "";
    let reasoning = "";
    let responseId: string | undefined;
    const salt = Math.random().toString(36).slice(2, 8);
    const calls: ToolCall[] = [];
    return {
      push(eventName, json) {
        if (!json || typeof json !== "object") return [];
        const record = json as { type?: string; response?: { id?: string }; item?: FnItem; delta?: unknown };
        const type = typeof record.type === "string" ? record.type : eventName;
        if ((type === "response.created" || type === "response.in_progress") && record.response?.id) responseId = record.response.id;
        if (type === "response.output_item.done" && record.item?.type === "function_call") {
          const item = record.item;
          const id = item.call_id || item.id || `call_${salt}_${calls.length}`;
          if (item.name && !calls.some((call) => call.id === id)) calls.push({ id, name: item.name, args: item.arguments ?? "" });
        }
        const events = interpretUpstream(eventName, json);
        for (const event of events) {
          if (event.event === "delta") text += event.data.text;
          if (event.event === "thought") reasoning += event.data.text;
        }
        return events;
      },
      result: () => ({ text, reasoning, calls: calls.slice(), responseId, finish: calls.length ? "tool_calls" : "stop" }),
    };
  },
  appendToolResults(body, outcome, results, opts) {
    const outputs = outcome.calls.map((call, index) => ({
      type: "function_call_output",
      call_id: call.id,
      output: resultText(results[index] ?? { ok: false, output: "no result" }),
    }));
    if (outcome.responseId && !opts.stateless) {
      return { ...body, previous_response_id: outcome.responseId, input: outputs };
    }
    const prior = Array.isArray(body.input) ? body.input : [];
    const assistant = outcome.text ? [{ role: "assistant", content: outcome.text }] : [];
    const items = outcome.calls.map((call) => ({ type: "function_call", call_id: call.id, name: call.name, arguments: call.args }));
    const { previous_response_id: _drop, ...rest } = body;
    void _drop;
    return { ...rest, input: [...prior, ...assistant, ...items, ...outputs] };
  },
};

type ChatDelta = {
  choices?: {
    delta?: { tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] };
    finish_reason?: string | null;
  }[];
};

export const chatAdapter: ProviderAdapter = {
  style: "chat",
  path: "/v1/chat/completions",
  buildBody(assembled, opts) {
    const body: Body = {
      model: opts.model,
      stream: true,
      max_tokens: opts.maxTokens,
      messages: [{ role: "system", content: assembled.system }, ...assembled.messages],
    };
    const tools = toChatTools(assembled.tools);
    if (tools.length) body.tools = tools;
    return body;
  },
  parser() {
    let text = "";
    let reasoning = "";
    let finish: string | undefined;
    const salt = Math.random().toString(36).slice(2, 8);
    const pending = new Map<number, { id: string; name: string; args: string }>();
    return {
      push(_eventName, json) {
        if (!json || typeof json !== "object") return [];
        for (const choice of (json as ChatDelta).choices ?? []) {
          if (choice?.finish_reason) finish = choice.finish_reason;
          for (const part of choice?.delta?.tool_calls ?? []) {
            let index: number;
            if (typeof part.index === "number") index = part.index;
            else {
              // No index (some OpenAI-compatible gateways): a chunk without a new id/name
              // continues the last call; a different id starts the next one.
              const lastIndex = pending.size ? Math.max(...pending.keys()) : -1;
              const last = pending.get(lastIndex);
              const fresh = !last || (part.id !== undefined && part.id !== last.id && last.id !== "") || (!part.id && !!part.function?.name && !!last.name && part.function.name !== last.name);
              index = fresh ? lastIndex + 1 : lastIndex;
            }
            const slot = pending.get(index) ?? { id: "", name: "", args: "" };
            if (part.id) slot.id = part.id;
            const name = part.function?.name;
            // Some gateways repeat the full name on every chunk; only append real fragments.
            if (name && name !== slot.name) slot.name += name;
            if (part.function?.arguments) slot.args += part.function.arguments;
            pending.set(index, slot);
          }
        }
        const events = interpretChatChunk(json);
        for (const event of events) {
          if (event.event === "delta") text += event.data.text;
          if (event.event === "thought") reasoning += event.data.text;
        }
        return events;
      },
      result() {
        const calls = [...pending.entries()]
          .sort(([a], [b]) => a - b)
          .filter(([, slot]) => slot.name)
          .map(([index, slot]) => ({ id: slot.id || `call_${salt}_${index}`, name: slot.name, args: slot.args }));
        return { text, reasoning, calls, finish };
      },
    };
  },
  appendToolResults(body, outcome, results, opts) {
    const prior = Array.isArray(body.messages) ? body.messages : [];
    const assistant: Record<string, unknown> = {
      role: "assistant",
      content: outcome.text || null,
      tool_calls: outcome.calls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.args || "{}" } })),
    };
    if (opts.echoReasoning && outcome.reasoning) assistant.reasoning_content = outcome.reasoning;
    const tools = outcome.calls.map((call, index) => ({
      role: "tool",
      tool_call_id: call.id,
      content: resultText(results[index] ?? { ok: false, output: "no result" }),
    }));
    return { ...body, messages: [...prior, assistant, ...tools] };
  },
};

export function adapterFor(style: ApiStyle): ProviderAdapter {
  return style === "chat" ? chatAdapter : responsesAdapter;
}
