import {
  EFFORTS,
  type ChatRequest,
  type Effort,
  type ModelId,
  type StepKind,
  type TraceStep,
} from "./types.ts";
import { isModelId } from "./provider.ts";
import { assemble, clipHistory, MAX_INSTRUCTIONS, MAX_MEMORY } from "./assemble.ts";
import { SERVER_TOOLS } from "./tools/server-tools.ts";

export { MAX_CHARS, MAX_INSTRUCTIONS, MAX_LAST, MAX_MEMORY, MAX_MESSAGES } from "./assemble.ts";
export const MAX_OUTPUT_TOKENS = 12_000;

export type ClientEvent =
  | { event: "delta"; data: { text: string } }
  | { event: "status"; data: { text: string } }
  | { event: "step"; data: { id: string; kind: StepKind; label: string; detail?: string; state?: "run" | "done"; sources?: string[]; parent?: string } }
  | { event: "thought"; data: { text: string } }
  | { event: "citation"; data: { url: string } }
  | { event: "image"; data: { src: string } }
  | { event: "notice"; data: { text: string } }
  | { event: "approval"; data: { id: string; tool: string; summary: string; preview?: string; state: "pending" | "approved" | "rejected" | "expired" } };

export type ParsedChat =
  | { ok: true; request: ChatRequest; notices: string[] }
  | { ok: false; error: string };

function clip(value: string, max: number) {
  return value.trim().slice(0, max);
}

/** Any well-formed model id: the provider decides whether it exists. */
export function isModel(value: unknown): value is ModelId {
  return isModelId(value);
}

export function isEffort(value: string): value is Effort {
  return EFFORTS.some((item) => item.id === value);
}

export function effortFor(model: ModelId, effort: Effort): { effort: Effort; notice?: string } {
  if (model === "grok-4.5" && effort === "xhigh") {
    return { effort: "high", notice: "grok-4.5 không có mức Sâu. Đang dùng Cao." };
  }
  return { effort };
}

export function parseChatRequest(body: unknown): ParsedChat {
  if (!body || typeof body !== "object") return { ok: false, error: "Thiếu nội dung." };
  const raw = body as Partial<ChatRequest>;
  if (!raw.model || !isModel(raw.model)) return { ok: false, error: "Mô hình không hợp lệ." };
  if (!Array.isArray(raw.messages) || raw.messages.length === 0) return { ok: false, error: "Chưa có tin nhắn." };

  const { messages, notices } = clipHistory(raw.messages);
  if (!messages.length || messages[messages.length - 1]?.role !== "user") {
    return { ok: false, error: "Tin nhắn cuối phải là của bạn." };
  }

  const tools = raw.tools ?? { web: false, x: false, code: false, image: false };
  const effort = typeof raw.effort === "string" && isEffort(raw.effort) ? raw.effort : "high";
  const mapped = effortFor(raw.model, effort);
  if (mapped.notice) notices.push(mapped.notice);

  return {
    ok: true,
    notices,
    request: {
      model: raw.model,
      effort: mapped.effort,
      instructions: clip(typeof raw.instructions === "string" ? raw.instructions : "", MAX_INSTRUCTIONS),
      memory: clip(typeof raw.memory === "string" ? raw.memory : "", MAX_MEMORY),
      messages,
      tools: {
        web: Boolean(tools.web),
        x: Boolean(tools.x),
        code: Boolean(tools.code),
        image: Boolean(tools.image),
        files: Boolean(tools.files),
        fetch: Boolean(tools.fetch),
        shell: Boolean(tools.shell),
        browser: Boolean(tools.browser),
      },
      ...(raw.remember === false ? { remember: false } : {}),
      ...(typeof raw.threadId === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(raw.threadId) ? { threadId: raw.threadId } : {}),
    },
  };
}

/** Legacy single-call prompt: server tools from the flags, no function tools. */
export function systemText(input: ChatRequest) {
  const flags = input.tools;
  const on: Record<string, boolean> = {
    web_search: flags.web,
    x_search: flags.x,
    code_interpreter: flags.code,
    image_generation: flags.image,
  };
  return assemble({
    instructions: input.instructions,
    memory: input.memory,
    messages: input.messages,
    tools: SERVER_TOOLS.filter((tool) => on[tool.name]),
  }).system;
}

export function responseTools(input: ChatRequest) {
  const tools: { type: string }[] = [];
  if (input.tools.web) tools.push({ type: "web_search" });
  if (input.tools.x) tools.push({ type: "x_search" });
  if (input.tools.code) tools.push({ type: "code_interpreter" });
  if (input.tools.image) tools.push({ type: "image_generation" });
  return tools;
}

type Item = {
  id?: string;
  call_id?: string;
  type?: string;
  name?: string;
  status?: string;
  code?: string;
  result?: string;
  action?: { query?: string; sources?: { url?: string }[] };
  outputs?: { logs?: string }[];
};

function httpUrl(value: unknown) {
  return typeof value === "string" && /^https?:\/\//.test(value) ? value : "";
}

function logsText(outputs: Item["outputs"]) {
  if (!Array.isArray(outputs)) return "";
  const parts: string[] = [];
  for (const output of outputs) {
    if (!output || typeof output.logs !== "string") continue;
    const raw = output.logs.trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as { stdout?: string; stderr?: string };
      if (parsed.stdout?.trim()) parts.push(parsed.stdout.trim());
      if (parsed.stderr?.trim()) parts.push(parsed.stderr.trim());
    } catch {
      parts.push(raw);
    }
  }
  return parts.join("\n").slice(0, 1_500);
}

function isXItem(item: Item) {
  const id = item.id || item.call_id || "";
  const name = item.name || "";
  return (
    item.type === "x_search_call" ||
    (item.type ?? "").includes("x_search") ||
    id.startsWith("xs_") ||
    name.includes("x_") ||
    name.includes("x_search")
  );
}

function itemId(item: Item) {
  return item.id || item.call_id || item.type || "step";
}

function reasoningText(item: Item) {
  const summary = (item as { summary?: { text?: string }[] }).summary;
  if (!Array.isArray(summary)) return "";
  return summary.map((part) => part?.text?.trim() || "").filter(Boolean).join("\n");
}

function runningStep(item: Item | undefined): ClientEvent | null {
  if (!item?.type || item.type === "reasoning") return null;
  const id = itemId(item);
  if (item.type === "web_search_call") {
    return { event: "step", data: { id, kind: "web", label: "Đang tìm trên web", state: "run" } };
  }
  if (isXItem(item)) return { event: "step", data: { id, kind: "x", label: "Đang tìm trên X", state: "run" } };
  if (item.type === "code_interpreter_call") {
    return { event: "step", data: { id, kind: "code", label: "Đang chạy mã", state: "run" } };
  }
  if (item.type === "image_generation_call") {
    return { event: "step", data: { id, kind: "image", label: "Đang tạo ảnh", state: "run" } };
  }
  return null;
}

function sourceUrls(item: Item) {
  const urls: string[] = [];
  for (const source of (item.action?.sources ?? []).slice(0, 6)) {
    const url = httpUrl(source?.url);
    if (url && !urls.includes(url)) urls.push(url);
  }
  return urls;
}

function fromItem(item: Item | undefined): ClientEvent[] {
  if (!item?.type) return [];
  if (item.type === "reasoning") {
    const text = reasoningText(item);
    return text ? [{ event: "thought", data: { text } }] : [];
  }
  const out: ClientEvent[] = [];
  const id = item.id || item.call_id || item.type;
  if (item.type === "web_search_call") {
    const query = item.action?.query?.trim();
    const sources = sourceUrls(item);
    out.push({
      event: "step",
      data: {
        id,
        kind: "web",
        label: query ? `Web · ${query}` : "Đã tìm trên web",
        state: "done",
        sources: sources.length ? sources : undefined,
      },
    });
  } else if (isXItem(item)) {
    const query = item.action?.query?.trim();
    const sources = sourceUrls(item);
    out.push({
      event: "step",
      data: {
        id,
        kind: "x",
        label: query ? `X · ${query}` : "Đã tìm trên X",
        state: "done",
        sources: sources.length ? sources : undefined,
      },
    });
  } else if (item.type === "code_interpreter_call") {
    const code = (item.code || "").trim();
    const logs = logsText(item.outputs);
    const detail = [code, logs].filter(Boolean).join("\n\n").slice(0, 2_000);
    out.push({
      event: "step",
      data: { id, kind: "code", label: "Đã chạy mã", detail: detail || undefined, state: "done" },
    });
  } else if (item.type === "image_generation_call" && item.result && item.result.length > 80) {
    const src = item.result.startsWith("data:") ? item.result : `data:image/jpeg;base64,${item.result}`;
    out.push({ event: "image", data: { src } });
    out.push({ event: "step", data: { id, kind: "image", label: "Đã tạo ảnh", state: "done" } });
  }
  return out;
}

export function interpretUpstream(eventName: string, json: unknown): ClientEvent[] {
  if (!json || typeof json !== "object") return [];
  const record = json as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : eventName;
  const out: ClientEvent[] = [];

  if (type === "response.output_text.delta" && typeof record.delta === "string" && record.delta) {
    out.push({ event: "delta", data: { text: record.delta } });
  }

  if (type === "response.output_text.annotation.added") {
    const annotation = record.annotation as { url?: string } | undefined;
    const url = httpUrl(annotation?.url);
    if (url) out.push({ event: "citation", data: { url } });
  }

  if (type === "response.web_search_call.searching" || type === "response.web_search_call.in_progress") {
    out.push({ event: "status", data: { text: "Đang tìm trên web" } });
  }
  if (type.includes("x_search") && (type.includes("in_progress") || type.includes("searching"))) {
    out.push({ event: "status", data: { text: "Đang tìm trên X" } });
  }
  if (type === "response.code_interpreter_call.in_progress" || type === "response.code_interpreter_call.interpreting") {
    out.push({ event: "status", data: { text: "Đang chạy mã" } });
  }
  if (type.includes("image_generation") && (type.includes("in_progress") || type.includes("generating"))) {
    out.push({ event: "status", data: { text: "Đang tạo ảnh" } });
  }
  if (type.includes("reasoning") && typeof record.delta === "string" && record.delta) {
    out.push({ event: "thought", data: { text: record.delta } });
  }

  if (type === "response.output_item.added") {
    const running = runningStep(record.item as Item | undefined);
    if (running) out.push(running);
  }

  if (type === "response.output_item.done") out.push(...fromItem(record.item as Item | undefined));

  if (type === "response.completed") {
    const response = record.response as { citations?: unknown } | undefined;
    if (Array.isArray(response?.citations)) {
      for (const url of response.citations) {
        const href = httpUrl(url);
        if (href) out.push({ event: "citation", data: { url: href } });
      }
    }
  }

  return out;
}

/**
 * One OpenAI-compatible `/v1/chat/completions` stream chunk → client events.
 * Covers DeepSeek/OpenRouter-style `reasoning_content` / `reasoning` deltas.
 */
export function interpretChatChunk(json: unknown): ClientEvent[] {
  if (!json || typeof json !== "object") return [];
  const record = json as {
    choices?: { delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown } }[];
    citations?: unknown;
  };
  const out: ClientEvent[] = [];
  for (const choice of record.choices ?? []) {
    const delta = choice?.delta;
    if (!delta) continue;
    const thought = typeof delta.reasoning_content === "string" ? delta.reasoning_content : delta.reasoning;
    if (typeof thought === "string" && thought) out.push({ event: "thought", data: { text: thought } });
    if (typeof delta.content === "string" && delta.content) out.push({ event: "delta", data: { text: delta.content } });
  }
  if (Array.isArray(record.citations)) {
    for (const url of record.citations) {
      const href = httpUrl(url);
      if (href) out.push({ event: "citation", data: { url: href } });
    }
  }
  return out;
}

/** Server tools that only an xAI Responses endpoint runs. */
export function unsupportedTools(input: ChatRequest) {
  return [
    input.tools.web ? "web_search" : "",
    input.tools.x ? "x_search" : "",
    input.tools.code ? "code_interpreter" : "",
    input.tools.image ? "image_generation" : "",
  ].filter(Boolean);
}

const GENERIC_STEP = /^(Đang|Đã) (tìm trên web|tìm trên X|chạy mã|tạo ảnh)$/;

function unite(prev: TraceStep, step: TraceStep): TraceStep {
  const sources = [...new Set([...(prev.sources ?? []), ...(step.sources ?? [])])].slice(0, 8);
  return {
    ...prev,
    ...step,
    id: step.id || prev.id,
    detail: step.detail ?? prev.detail,
    state: step.state ?? prev.state,
    sources: sources.length ? sources : undefined,
  };
}

function stripGeneric(steps: TraceStep[], step: TraceStep) {
  if (GENERIC_STEP.test(step.label)) return steps;
  return steps.filter((item) => item.id === step.id || !(item.kind === step.kind && GENERIC_STEP.test(item.label)));
}

export function mergeTrace(steps: TraceStep[], step: TraceStep): TraceStep[] {
  const replace = (index: number) => {
    const next = steps.slice();
    next[index] = unite(steps[index], step);
    return stripGeneric(next, step);
  };
  const byId = steps.findIndex((item) => item.id === step.id);
  if (byId >= 0) return replace(byId);
  if (!GENERIC_STEP.test(step.label)) {
    const running = steps.findIndex((item) => item.kind === step.kind && item.parent === step.parent && item.state !== "done" && GENERIC_STEP.test(item.label));
    if (running >= 0) return replace(running);
  }
  const same = steps.findIndex((item) => item.kind === step.kind && item.parent === step.parent && item.label === step.label);
  if (same >= 0) return replace(same);
  if (GENERIC_STEP.test(step.label) && steps.some((item) => item.kind === step.kind && !GENERIC_STEP.test(item.label))) {
    return steps;
  }
  return stripGeneric([...steps, step], step);
}

const slots = new Map<string, number[]>();

export function takeSlot(name: string, limit: number, windowMs: number) {
  const now = Date.now();
  const fresh = (slots.get(name) ?? []).filter((stamp) => now - stamp < windowMs);
  if (fresh.length >= limit) {
    slots.set(name, fresh);
    return false;
  }
  fresh.push(now);
  slots.set(name, fresh);
  return true;
}
