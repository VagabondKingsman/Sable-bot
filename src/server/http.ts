/**
 * Small helpers shared by the JSON API routes: a body reader that enforces the
 * size limit while streaming (a missing or lying Content-Length, e.g. chunked
 * uploads, cannot bypass it), a 405 for unsupported methods, and a guard that
 * turns unexpected exceptions into a plain 500 without leaking details.
 */

export type BodyResult =
  | { ok: true; value: unknown }
  | { ok: false; status: 400 | 413; message: string };

export const TOO_LARGE = "Yêu cầu quá lớn.";
export const UNREADABLE = "Không đọc được yêu cầu.";

/** W2c: bounded raw body (Content-Length pre-check + streaming cap). Empty body → "". */
export async function readTextBody(request: Request, maxBytes: number): Promise<{ ok: true; text: string } | { ok: false; status: 400 | 413; message: string }> {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > maxBytes) return { ok: false, status: 413, message: TOO_LARGE };
  if (!request.body) return { ok: true, text: "" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        void reader.cancel().catch(() => {});
        return { ok: false, status: 413, message: TOO_LARGE };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, status: 400, message: UNREADABLE };
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(bytes) };
}

export async function readJsonBody(request: Request, maxBytes: number): Promise<BodyResult> {
  if (!request.body && !(Number(request.headers.get("content-length") || 0) > maxBytes)) return { ok: false, status: 400, message: UNREADABLE };
  const read = await readTextBody(request, maxBytes);
  if (!read.ok) return read;
  try {
    return { ok: true, value: JSON.parse(read.text) as unknown };
  } catch {
    return { ok: false, status: 400, message: UNREADABLE };
  }
}

/** Plain JSON object body (not null, not an array) or an error response. */
export async function readObjectBody(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; response: Response }> {
  const read = await readJsonBody(request, maxBytes);
  if (!read.ok)
    return { ok: false, response: Response.json({ message: read.message }, { status: read.status }) };
  const value = read.value;
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { ok: false, response: Response.json({ message: UNREADABLE }, { status: 400 }) };
  return { ok: true, body: value as Record<string, unknown> };
}

export function methodNotAllowed(allow: string) {
  return () =>
    Response.json(
      { message: "Phương thức không được hỗ trợ." },
      { status: 405, headers: { allow } },
    );
}

/** Run a handler; an unexpected throw becomes a generic 500 (details go to the server log only). */
export async function guarded(label: string, run: () => Promise<Response> | Response) {
  try {
    return await run();
  } catch (error) {
    console.error(`[sable] ${label} failed:`, error instanceof Error ? error.message : error);
    return Response.json({ message: "Máy chủ gặp lỗi, thử lại sau." }, { status: 500 });
  }
}
