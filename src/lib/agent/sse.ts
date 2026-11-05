/** Upstream SSE → `{ event, json }` frames. Pure (works on any byte stream). */
export type Frame = { event: string; json: unknown };

export class UpstreamError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
  }
}

function frameError(json: unknown) {
  const failure = (json as { error?: { message?: string } | string } | null)?.error;
  if (!failure) return "";
  return (typeof failure === "string" ? failure : failure.message || "Mô hình trả về lỗi.").slice(0, 240);
}

export async function* sseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<Frame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let carry = "";
  let eventName = "";
  const take = function* (line: string): Generator<Frame> {
    const trimmed = line.replace(/\r$/, "");
    if (!trimmed.trim()) {
      eventName = "";
      return;
    }
    if (trimmed.startsWith("event:")) {
      eventName = trimmed.slice(6).trim();
      return;
    }
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trim();
    const name = eventName;
    eventName = "";
    if (!data || data === "[DONE]") return;
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    const failure = frameError(json);
    if (failure) throw new UpstreamError(failure);
    yield { event: name, json };
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      carry += decoder.decode(value, { stream: true });
      const lines = carry.split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) yield* take(line);
    }
    if (carry.trim()) yield* take(carry);
  } finally {
    reader.cancel().catch(() => undefined);
  }
}
