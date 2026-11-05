/** Outbound: build a redacted, size-capped handoff and POST it signed. SSRF-checked, no redirects. */
import { redactSecrets } from "../memory/redact.ts";
import { checkUrl as defaultCheck, parseAllowlist } from "../tools/fetch.ts";
import { MAX_BODY, MAX_TEXT, MAX_TITLE, makeMessage, parseMessage, signedHeaders, verify, H_NONCE, H_SIG, H_TS, type BridgeMessage, type OutType } from "./protocol.ts";

export type Draft = { kind: OutType; title: string; text: string };

/** Mask exact occurrences of known secret values (vault values, Sable's own secrets) then pattern-redact. */
export function redactPayload(text: string, known: string[] = []): { text: string; redactions: number } {
  let out = text;
  let n = 0;
  for (const s of known) {
    if (!s || s.length < 8) continue;
    const parts = out.split(s);
    if (parts.length > 1) {
      n += parts.length - 1;
      out = parts.join("[đã ẩn]");
    }
  }
  const r = redactSecrets(out);
  return { text: r.text, redactions: n + r.hits.length };
}

export function buildHandoff(d: Draft, known: string[] = [], extra: { id?: string; at?: number } = {}): { msg: BridgeMessage; body: string; redactions: number; clipped: boolean } {
  const t = redactPayload(d.title.trim().slice(0, MAX_TITLE * 2), known);
  const x = redactPayload(d.text, known);
  const clipped = x.text.length > MAX_TEXT || t.text.length > MAX_TITLE;
  const msg = makeMessage(d.kind, { title: t.text.slice(0, MAX_TITLE), text: x.text.slice(0, MAX_TEXT) }, extra);
  const body = JSON.stringify(msg);
  if (Buffer.byteLength(body) > MAX_BODY) throw new Error(`payload over ${MAX_BODY} bytes`);
  return { msg, body, redactions: t.redactions + x.redactions, clipped };
}

export type SendResult = { ok: boolean; status: number; ms: number; error?: string; reply?: BridgeMessage; replyVerified?: boolean };

export async function sendSigned(
  url: string,
  secret: string,
  body: string,
  opts: { peerToken?: string | null; fetchImpl?: typeof fetch; check?: typeof defaultCheck; allow?: string[]; fakeIp?: boolean; loopbackOrigin?: string; timeoutMs?: number; now?: () => number } = {},
): Promise<SendResult> {
  const t0 = Date.now();
  try {
    const u = new URL(url);
    // The only non-public target ever allowed is the in-process mock peer Sable itself started (exact origin).
    const mock = opts.loopbackOrigin && u.origin === opts.loopbackOrigin && /^http:\/\/127\.0\.0\.1:\d+$/.test(u.origin);
    if (!mock) {
      if (u.protocol !== "https:") throw new Error("peer URL must be https");
      await (opts.check ?? defaultCheck)(url, opts.allow ?? parseAllowlist(process.env.SABLE_FETCH_ALLOW), undefined, opts.fakeIp ?? process.env.SABLE_FETCH_FAKE_IP === "1");
    }
    const headers: Record<string, string> = { ...signedHeaders(secret, body, opts.now?.() ?? Date.now()), "user-agent": "SableBridge/1" };
    if (opts.peerToken) headers.authorization = `Bearer ${opts.peerToken}`;
    const res = await (opts.fetchImpl ?? fetch)(url, { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000) });
    const ms = Date.now() - t0;
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined);
      return { ok: false, status: res.status, ms, error: "redirect refused" };
    }
    const text = (await readCapped(res, MAX_BODY)) ?? "";
    if (!res.ok) return { ok: false, status: res.status, ms, error: `peer HTTP ${res.status}` };
    // Optional signed reply (e.g. pong). Verified, parsed, never acted on.
    let reply: BridgeMessage | undefined;
    let replyVerified = false;
    if (text && res.headers.get(H_SIG)) {
      const v = verify(secret, text, { sig: res.headers.get(H_SIG), ts: res.headers.get(H_TS), nonce: res.headers.get(H_NONCE) });
      try {
        const p = parseMessage(JSON.parse(text), ["pong", "result", "message"]);
        if (p.ok) {
          reply = p.msg;
          replyVerified = v.ok;
        }
      } catch {
        /* not JSON */
      }
    }
    return { ok: true, status: res.status, ms, ...(reply ? { reply, replyVerified } : {}) };
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
  }
}

async function readCapped(res: Response, max: number): Promise<string | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
