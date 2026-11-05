/**
 * Inbound: verify + parse a peer message. Pure decision function — the caller only stores what this
 * returns. Inbound content is data, never instructions: it cannot decide approvals, start runs,
 * call tools, or change settings (there is no code path for it to do so).
 */
import { redactSecrets } from "../memory/redact.ts";
import { ERRORS, IN_TYPES, MAX_BODY, NonceCache, SlidingLimiter, makeMessage, parseMessage, verify, type BridgeMessage, type ErrorCode } from "./protocol.ts";

export type InboundDeps = {
  secret: string | null;
  enabled: boolean;
  nonces: NonceCache;
  limiter: SlidingLimiter;
  /** Failed-auth limiter (protects the HMAC check from brute force). */
  badLimiter: SlidingLimiter;
  now?: number;
};

export type InboundOutcome =
  | { status: number; body: { ok: false; code: ErrorCode; message: string } }
  | { status: 200 | 202; body: { ok: true; id: string; code: "accepted" | "pong" }; accepted?: BridgeMessage; reply?: BridgeMessage };

const err = (code: ErrorCode, message: string) => ({ status: ERRORS[code], body: { ok: false as const, code, message } });

export function handleInbound(raw: string, headers: { sig?: string | null; ts?: string | null; nonce?: string | null }, deps: InboundDeps): InboundOutcome {
  const now = deps.now ?? Date.now();
  if (!deps.enabled || !deps.secret) return err("bridge_off", "bridge is off or not configured");
  if (Buffer.byteLength(raw) > MAX_BODY) return err("too_large", `body over ${MAX_BODY} bytes`);
  if (!deps.limiter.allow(now)) return err("rate_limited", "too many requests");
  const v = verify(deps.secret, raw, headers, now);
  if (!v.ok) {
    if (!deps.badLimiter.allow(now)) return err("rate_limited", "too many failed signatures");
    return err(v.code, v.message);
  }
  if (!deps.nonces.claim(`n:${v.nonce}`, now)) return err("replay", "nonce already used");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return err("bad_request", "invalid JSON");
  }
  const p = parseMessage(json, IN_TYPES);
  if (!p.ok) return err("bad_schema", p.error);
  if (!deps.nonces.claim(`id:${p.msg.id}`, now)) return err("replay", "message id already processed");
  if (p.msg.type === "ping") return { status: 200, body: { ok: true, id: p.msg.id, code: "pong" }, reply: makeMessage("pong", { text: "ok" }, { inReplyTo: p.msg.id }) };
  // Redact before anything is stored or shown.
  const title = redactSecrets(p.msg.body.title ?? "").text;
  const text = redactSecrets(p.msg.body.text ?? "").text;
  return { status: 202, body: { ok: true, id: p.msg.id, code: "accepted" }, accepted: { ...p.msg, body: { ...p.msg.body, title, text } } };
}
