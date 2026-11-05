import type { ClientEvent } from "@/lib/agent/harness";
import { previewPathPrefix } from "@/lib/preview-path-prefix";
import type { AgentSettings, ApprovalRequest, ChatRequest, TraceStep } from "@/lib/agent/types";

export function withPrefix(path: string) {
  if (typeof window === "undefined") return path;
  const prefix = previewPathPrefix(window.location.hostname, window.location.pathname);
  return prefix ? `${prefix}${path}` : path;
}

export async function readError(res: Response, fallback: string) {
  try {
    const payload = (await res.json()) as { message?: string };
    if (payload.message) return payload.message;
  } catch {
    /* keep fallback */
  }
  return fallback;
}

type MediaBody = Pick<AgentSettings, "imageModel" | "imageAspect" | "imageResolution" | "videoAspect" | "videoSeconds">;

function joinedSignal(signal: AbortSignal, ms: number) {
  return AbortSignal.any([signal, AbortSignal.timeout(ms)]);
}

export async function generateImage(prompt: string, signal: AbortSignal, options: MediaBody) {
  const res = await fetch(withPrefix("/api/media"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      kind: "image",
      prompt,
      imageModel: options.imageModel,
      imageAspect: options.imageAspect,
      imageResolution: options.imageResolution,
    }),
    signal: joinedSignal(signal, 120_000),
  });
  if (!res.ok) throw new Error(await readError(res, "Không tạo được ảnh."));
  const body = (await res.json()) as { url?: string };
  if (!body.url) throw new Error("Không nhận được ảnh.");
  return body.url;
}

export async function generateVideo(prompt: string, signal: AbortSignal, options: MediaBody, onWait: () => void) {
  const limited = joinedSignal(signal, 240_000);
  const res = await fetch(withPrefix("/api/media"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      kind: "video",
      prompt,
      videoAspect: options.videoAspect,
      videoSeconds: options.videoSeconds,
    }),
    signal: limited,
  });
  if (!res.ok) throw new Error(await readError(res, "Không tạo được video."));
  const started = (await res.json()) as { requestId?: string };
  if (!started.requestId) throw new Error("Không nhận được mã video.");
  for (let attempt = 0; attempt < 45; attempt += 1) {
    onWait();
    await wait(4_000, limited);
    const poll = await fetch(`${withPrefix("/api/media")}?id=${encodeURIComponent(started.requestId)}`, {
      signal: limited,
    });
    if (!poll.ok) throw new Error(await readError(poll, "Không đọc được video."));
    const body = (await poll.json()) as { status?: string; url?: string; message?: string };
    if (body.status === "done" && body.url) return body.url;
    if (body.status === "failed") throw new Error(body.message || "Video lỗi.");
  }
  throw new Error("Video chưa xong. Thử lại.");
}

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export type ModelCaps = { serverTools: boolean; style: "responses" | "chat" };

export type ModelInfo = {
  ready: boolean;
  models: string[];
  provider: string | null;
  serverTools: boolean;
  imagine: boolean;
  functionTools: boolean;
  capabilities: Record<string, ModelCaps>;
};

/** What the server has wired: any OpenAI-compatible provider(s) and their models. */
export async function modelInfo(signal?: AbortSignal): Promise<ModelInfo> {
  const res = await fetch(withPrefix("/api/chat"), { signal });
  if (!res.ok) return { ready: false, models: [], provider: null, serverTools: false, imagine: false, functionTools: false, capabilities: {} };
  const body = (await res.json()) as Partial<ModelInfo>;
  return {
    ready: Boolean(body.ready),
    models: Array.isArray(body.models) ? body.models.filter((item) => typeof item === "string") : [],
    provider: typeof body.provider === "string" ? body.provider : null,
    serverTools: Boolean(body.serverTools),
    imagine: Boolean(body.imagine),
    functionTools: body.functionTools !== false,
    capabilities: body.capabilities && typeof body.capabilities === "object" ? body.capabilities : {},
  };
}

/** Answer a pending write-tool approval. */
export async function decideApproval(id: string, approve: boolean) {
  const res = await fetch(withPrefix("/api/tools"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, approve }),
  });
  if (!res.ok) throw new Error(await readError(res, "Không gửi được lựa chọn."));
}

export async function modelReady(signal?: AbortSignal) {
  return (await modelInfo(signal)).ready;
}

function parseBlock(block: string, handlers: StreamHandlers) {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  const data = dataLines.join("\n");
  if (!data) return;
  let payload: {
    text?: string;
    message?: string;
    url?: string;
    id?: string;
    kind?: TraceStep["kind"];
    label?: string;
    detail?: string;
    state?: TraceStep["state"];
    sources?: string[];
    parent?: string;
    src?: string;
    tool?: string;
    summary?: string;
    preview?: string;
  };
  try {
    payload = JSON.parse(data) as typeof payload;
  } catch {
    return;
  }
  if (event === "delta" && payload.text) handlers.onDelta(payload.text);
  else if (event === "status" && payload.text) handlers.onStatus(payload.text);
  else if (event === "notice" && payload.text) handlers.onNotice(payload.text);
  else if (event === "step" && payload.id && payload.kind && payload.label) {
    handlers.onStep({
      id: payload.id,
      kind: payload.kind,
      label: payload.label,
      detail: payload.detail,
      state: payload.state,
      sources: Array.isArray(payload.sources) ? payload.sources.filter((url) => typeof url === "string").slice(0, 8) : undefined,
      parent: typeof payload.parent === "string" ? payload.parent.slice(0, 300) : undefined,
    });
  } else if (event === "thought" && payload.text) handlers.onThought(payload.text);
  else if (event === "citation" && payload.url) handlers.onCitation(payload.url);
  else if (event === "image" && payload.src) handlers.onImage(payload.src);
  else if (event === "approval" && payload.id && payload.summary) {
    const state = (payload as { state?: string }).state;
    handlers.onApproval?.({
      id: payload.id,
      tool: payload.tool ?? "tool",
      summary: payload.summary,
      preview: payload.preview,
      state: state === "approved" || state === "rejected" || state === "expired" ? state : "pending",
    });
  }
  else if (event === "error") throw new Error(payload.message || "Mô hình dừng giữa chừng.");
}

type StreamHandlers = {
  onDelta: (text: string) => void;
  onStatus: (text: string) => void;
  onNotice: (text: string) => void;
  onStep: (step: TraceStep) => void;
  onThought: (text: string) => void;
  onCitation: (url: string) => void;
  onImage: (src: string) => void;
  onApproval?: (approval: ApprovalRequest) => void;
  signal: AbortSignal;
};

export async function streamReply(body: ChatRequest, handlers: StreamHandlers) {
  const res = await fetch(withPrefix("/api/chat"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: handlers.signal,
  });
  if (!res.ok || !res.body) throw new Error(await readError(res, "Không gửi được."));

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let carry = "";
  const take = (block: string) => {
    if (block.trim()) parseBlock(block, handlers);
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    carry += decoder.decode(value, { stream: true });
    const blocks = carry.split("\n\n");
    carry = blocks.pop() ?? "";
    for (const block of blocks) take(block);
  }
  take(carry);
}

export type { ClientEvent };
