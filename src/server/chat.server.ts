import { mediaToolsFor } from "@/server/media.server";
import { auditingEmit, auditSink } from "@/server/audit.server";
import { USER } from "@/lib/agent/audit/types";
import { MAX_OUTPUT_TOKENS, parseChatRequest, takeSlot, type ClientEvent } from "@/lib/agent/harness";
import { adapterFor, type CallOpts } from "@/lib/agent/adapters";
import { assemble } from "@/lib/agent/assemble";
import { DEFAULT_MAX_STEPS, runAgent, type Transport } from "@/lib/agent/loop";
import { sseFrames, UpstreamError } from "@/lib/agent/sse";
import { sharedApprovals } from "@/lib/agent/tools/approvals";
import { defaultRegistry, selectTools, skipNotices } from "@/lib/agent/tools/registry";
import type { ToolContext } from "@/lib/agent/tools/types";
import type { ChatRequest } from "@/lib/agent/types";
import { dataDir, workspaceDir } from "@/server/paths";
import { makeAssertScope } from "@/server/scope.server";
import { createSpawner, spawnOn } from "@/server/spawn.server";
import { mcpToolsFor, mcpWarm } from "@/server/mcp.server";
import { connectorToolsFor } from "@/server/connectors.server";
import { skills as skillStoreNow, skillsForTurn, skillsOn } from "@/server/skills.server";
import { shellOn } from "@/lib/agent/tools/shell";
import { browserOn } from "@/lib/agent/tools/browser";
import { canvasOn } from "@/lib/agent/tools/canvas";
import { voiceStatus } from "@/server/voice.server";
import { accessFor, completerFor, learnedFor, memoryOn, memoryStore, queueExtraction } from "@/server/memory.server";
import type { MemorySource } from "@/lib/agent/memory/types";
import {
  availableModels,
  endpointFor,
  imagineEndpoint,
  resolveEndpoints,
  type Endpoint,
} from "@/lib/agent/provider";

/** Rate-limit window; override with CHAT_RATE_WINDOW_MIN (minutes). */
const WINDOW_MS = (Number(process.env.CHAT_RATE_WINDOW_MIN) || 10) * 60 * 1000;
/** Chats per window. CHAT_RATE_LIMIT=0 (or "off"/"unlimited") disables the limit. Default: unlimited. */
const RAW_CHAT_LIMIT = (process.env.CHAT_RATE_LIMIT ?? "0").trim().toLowerCase();
const CHAT_LIMIT =
  RAW_CHAT_LIMIT === "off" || RAW_CHAT_LIMIT === "unlimited" ? 0 : Math.max(0, Number(RAW_CHAT_LIMIT) || 0);

/** Max tokens for chat/completions providers (DeepSeek caps deepseek-chat at 8192). */
const CHAT_MAX_TOKENS = Math.min(MAX_OUTPUT_TOKENS, Number(process.env.LLM_MAX_TOKENS) || 8_192);

export function endpoints(): Endpoint[] {
  return resolveEndpoints(process.env);
}

/** Primary endpoint base (LLM_* → XAI_* → OPENAI_* → DEEPSEEK_*). */
export function apiBase() {
  return endpoints()[0]?.base ?? "https://api.x.ai";
}

export function apiKey() {
  return endpoints()[0]?.key ?? "";
}

export function providerInfo() {
  const list = endpoints();
  const imagine = imagineEndpoint(list);
  return {
    ready: list.length > 0,
    models: availableModels(process.env, list),
    provider: list[0]?.label ?? null,
    providers: list.map((item) => ({ id: item.id, label: item.label, style: item.style, models: item.models })),
    serverTools: list.some((item) => item.style === "responses" && item.xai),
    functionTools: functionToolsOn(),
    /** Per model: can it run xAI server tools / Imagine, or only Sable function tools? */
    capabilities: Object.fromEntries(
      availableModels(process.env, list).map((model) => {
        const owner = endpointFor(model, list);
        return [model, { serverTools: Boolean(owner && owner.style === "responses" && owner.xai), style: owner?.style ?? "chat" }];
      }),
    ),
    imagine: Boolean(imagine),
    voice: voiceStatus(),
  };
}

function sse(encoder: TextEncoder, event: string, data: unknown) {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function upstreamError(res: Response) {
  let message = `Mô hình trả về lỗi ${res.status}.`;
  try {
    const body = (await res.json()) as { error?: { message?: string } | string; message?: string };
    const nested = body.error;
    const text = typeof nested === "string" ? nested : nested?.message || body.message;
    if (text) message = text.slice(0, 240);
  } catch {
    /* keep status line */
  }
  return message;
}

export function modelReady() {
  return endpoints().length > 0;
}

/** Max tool steps per chat turn (SABLE_MAX_STEPS, 1-10). */
const MAX_STEPS = Math.min(10, Math.max(1, Number(process.env.SABLE_MAX_STEPS) || DEFAULT_MAX_STEPS));
/** Whole-turn cap across all steps. */
const TURN_MS = 240_000;

/** Sable-run function tools: SABLE_TOOLS=0 turns them off (kill switch). */
export function functionToolsOn() {
  return (process.env.SABLE_TOOLS ?? "1").trim() !== "0";
}

export { workspaceDir };

export function capabilitiesFor(endpoint: Endpoint) {
  return { serverTools: endpoint.style === "responses" && endpoint.xai, functionTools: functionToolsOn() };
}

function transportFor(endpoint: Endpoint): Transport {
  return async function* (path, body, signal) {
    const res = await fetch(`${endpoint.base}${path}`, {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${endpoint.key}` },
      body: JSON.stringify(body),
    });
    if (!res.ok || !res.body) throw new UpstreamError(await upstreamError(res), res.status);
    yield* sseFrames(res.body);
  };
}

export type PreparedTurn = {
  endpoint: Endpoint;
  adapter: ReturnType<typeof adapterFor>;
  assembled: ReturnType<typeof assemble>;
  opts: CallOpts;
  functions: ReturnType<typeof selectTools>["functions"];
  transport: Transport;
  notices: string[];
  /** Learned-memory access for ToolContext (absent when memory is off). */
  memory?: import("@/lib/agent/tools/types").MemoryAccess;
  /** This turn may be learned from after it finishes. */
  canLearn: boolean;
  /** All tools live this turn (server + function), for sub-agent selection. */
  active: import("@/lib/agent/tools/types").ToolDef[];
  /** load_skill access (absent when skills are off or none exist). */
  skills?: import("@/lib/agent/tools/types").ToolContext["skills"];
};

/** Endpoint, tool selection, prompt and call options for one turn (chat or background job). */
export type TurnScope = {
  /** interactive = the user is in this chat; background = job/routine/channel run. */
  mode: "interactive" | "background";
  source: MemorySource;
  sourceRef?: string;
  /** 1 = a sub-agent turn (never gets spawn_agent). */
  depth?: 0 | 1;
  /** Offer MCP tools (chat + jobs only; never the memory extractor). */
  mcp?: boolean;
};

export function prepareTurn(
  input: ChatRequest,
  extraInstructions = "",
  scope: TurnScope = { mode: "background", source: "job" },
): PreparedTurn | null {
  const endpoint = endpointFor(input.model, endpoints());
  if (!endpoint) return null;
  const chatStyle = endpoint.style === "chat";
  const store = memoryStore(dataDir());
  const memOn = memoryOn(store);
  // Only the interactive chat, when the user did not say "don't remember this chat", may write memory.
  const canWrite = memOn && scope.mode === "interactive" && input.remember !== false;
  const flags = { ...input.tools, learned: memOn && functionToolsOn(), agents: spawnOn() && functionToolsOn() && scope.depth !== 1, skills: skillsOn() && functionToolsOn() && skillStoreNow().list().length > 0, shell: shellOn() && functionToolsOn(), browser: browserOn() && functionToolsOn(), canvas: canvasOn() && functionToolsOn() && Boolean(input.tools.files) };
  const base = selectTools(defaultRegistry(), flags, capabilitiesFor(endpoint));
  const mcpDefs = scope.mcp && functionToolsOn() && scope.depth !== 1 ? [...mcpToolsFor(scope.source), ...connectorToolsFor(scope.source), ...mediaToolsFor(scope.source)] : [];
  const picked = mcpDefs.length ? { ...base, active: [...base.active, ...mcpDefs], functions: [...base.functions, ...mcpDefs] } : base;
  const selection = canWrite
    ? picked
    : { ...picked, active: picked.active.filter(writesMemoryNot), functions: picked.functions.filter(writesMemoryNot) };
  const skillTurn = selection.functions.some((t) => t.name === "load_skill") ? skillsForTurn(selection.active.map((t) => t.name)) : null;
  const notices = skipNotices(selection, `${endpoint.label} (${input.model})`, functionToolsOn());
  const assembled = assemble({
    instructions: extraInstructions ? `${input.instructions}\n\n${extraInstructions}`.trim() : input.instructions,
    memory: input.memory,
    messages: input.messages,
    tools: selection.active,
    learned: memOn ? learnedFor(store, input) : "",
    skills: skillTurn?.catalog ?? "",
    now: new Date(),
  });
  const opts: CallOpts = {
    model: input.model,
    effort: input.effort,
    maxTokens: chatStyle ? CHAT_MAX_TOKENS : MAX_OUTPUT_TOKENS,
    codeOutputs: selection.active.some((tool) => tool.name === "code_interpreter"),
    echoReasoning: endpoint.id === "deepseek" || endpoint.base.includes("deepseek"),
    stateless: (process.env.SABLE_RESPONSES_STATELESS ?? "").trim() === "1",
  };
  const memory = memOn ? accessFor(store, canWrite, scope.source, scope.sourceRef) : undefined;
  return { endpoint, adapter: adapterFor(endpoint.style), assembled, opts, functions: selection.functions, transport: transportFor(endpoint), notices, memory, canLearn: canWrite, active: selection.active, skills: skillTurn?.access };
}

function writesMemoryNot(tool: { name: string }) {
  return tool.name !== "memory_save" && tool.name !== "memory_forget";
}

export async function streamChat(input: ChatRequest, notices: string[], signal: AbortSignal) {
  await mcpWarm();
  const turn = prepareTurn(input, "", { mode: "interactive", source: "chat", sourceRef: input.threadId, mcp: true });
  if (!turn) return Response.json({ message: "Mô hình chưa sẵn sàng trong môi trường này." }, { status: 503 });
  if (CHAT_LIMIT > 0 && !takeSlot("chat", CHAT_LIMIT, WINDOW_MS)) {
    return Response.json({ message: "Đã chạm trần dùng trong vài phút. Đợi một lát rồi gửi lại." }, { status: 429 });
  }
  const { endpoint, adapter, assembled, opts, transport } = turn;
  notices.push(...turn.notices);
  // Aborted when the client goes away (request signal or stream cancel) or the turn runs too long.
  const stop = new AbortController();
  const turnSignal = AbortSignal.any([signal, stop.signal, AbortSignal.timeout(TURN_MS)]);

  // Fail fast with a real HTTP status when the first model call is rejected.
  const first = adapter.buildBody(assembled, opts);
  let firstRes: Response;
  try {
    firstRes = await fetch(`${endpoint.base}${adapter.path}`, {
      method: "POST",
      signal: turnSignal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${endpoint.key}` },
      body: JSON.stringify(first),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Mất kết nối tới mô hình.";
    return Response.json({ message: message.slice(0, 240) }, { status: 502 });
  }
  if (!firstRes.ok || !firstRes.body) {
    return Response.json({ message: await upstreamError(firstRes) }, { status: 502 });
  }
  let primed: ReadableStream<Uint8Array> | null = firstRes.body;
  const primedTransport: Transport = (path, body, sig) => {
    if (primed) {
      const stream = primed;
      primed = null;
      return sseFrames(stream);
    }
    return transport(path, body, sig);
  };

  const encoder = new TextEncoder();
  const approvals = sharedApprovals();
  let cancelled = false;

  const stream = new ReadableStream({
    async start(controller) {
      let lastStatus = "";
      const emit = (piece: ClientEvent) => {
        if (cancelled) return;
        if (piece.event === "delta") lastStatus = "";
        if (piece.event === "status") {
          if (piece.data.text === lastStatus) return;
          lastStatus = piece.data.text;
        }
        try {
          controller.enqueue(sse(encoder, piece.event, piece.data));
        } catch {
          cancelled = true;
        }
      };
      for (const text of notices) emit({ event: "notice", data: { text } });
      const ctx: ToolContext = {
        workspaceDir: workspaceDir(),
        signal: turnSignal,
        mode: "interactive",
        approve: (ask) => approvals.request(ask, auditingEmit(emit, USER), turnSignal),
        memory: turn.memory,
        skills: turn.skills,
        scopeId: null,
        assertScope: makeAssertScope(null, "interactive"),
        initiator: USER,
        audit: auditSink(),
      };
      if (turn.functions.some((tool) => tool.name === "spawn_agent")) ctx.spawn = createSpawner(turn, turn.active, emit);
      try {
        const result = await runAgent(assembled, { adapter, transport: primedTransport, tools: turn.functions, ctx, emit, opts, maxSteps: MAX_STEPS });
        if (!cancelled) controller.enqueue(sse(encoder, "done", {}));
        if (turn.canLearn && result.text.trim()) {
          const learnModel = process.env.SABLE_MEMORY_MODEL?.trim();
          const learnInput: ChatRequest = { ...input, model: learnModel || input.model, effort: "low", tools: { web: false, x: false, code: false, image: false } };
          queueExtraction(
            { store: memoryStore(dataDir()), complete: completerFor(() => prepareTurn(learnInput) ?? prepareTurn({ ...learnInput, model: input.model })) },
            [...input.messages.slice(-5), { role: "assistant", content: result.text }],
            input.threadId,
          );
        }
      } catch (error) {
        if (!signal.aborted && !cancelled && !stop.signal.aborted) {
          const timedOut = turnSignal.aborted;
          const message = timedOut
            ? "Lượt này chạy quá 4 phút nên đã dừng."
            : error instanceof Error
              ? error.message
              : "Mất kết nối tới mô hình.";
          controller.enqueue(sse(encoder, "error", { message: message.slice(0, 240) }));
        }
      }
      if (!cancelled) {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      cancelled = true;
      stop.abort();
      primed?.cancel().catch(() => undefined);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

export { parseChatRequest, mcpWarm };
