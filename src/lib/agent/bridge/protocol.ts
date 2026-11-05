/**
 * W6 (D9) Sable ↔ peer-agent bridge, wire protocol `sable.bridge.v1`. Pure + dependency-free.
 *
 * Signature: hex HMAC-SHA256(secret, `sable.bridge.v1:${timestamp}:${nonce}:${rawBody}`), sent as
 *   X-Bridge-Signature: v1=<hex>   X-Bridge-Timestamp: <unix seconds>   X-Bridge-Nonce: <16..64 [A-Za-z0-9_-]>
 * Replay protection: |now - timestamp| ≤ 300 s, and each nonce (and message id) is accepted once.
 * See docs/BRIDGE-PROTOCOL.md.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SCHEMA = "sable.bridge.v1" as const;
export const MAX_BODY = 64_000;
export const MAX_TEXT = 16_000;
export const MAX_TITLE = 200;
export const WINDOW_S = 300;
export const H_SIG = "x-bridge-signature";
export const H_TS = "x-bridge-timestamp";
export const H_NONCE = "x-bridge-nonce";

/** Sable → peer: handoff.task | handoff.question | ping. Peer → Sable: result | message | ping | pong. */
export const OUT_TYPES = ["handoff.task", "handoff.question", "ping"] as const;
export const IN_TYPES = ["result", "message", "ping", "pong"] as const;
export type OutType = (typeof OUT_TYPES)[number];
export type InType = (typeof IN_TYPES)[number];
export type BridgeType = OutType | InType;

export type BridgeMessage = {
  schema: typeof SCHEMA;
  id: string;
  type: BridgeType;
  from: "sable" | "peer";
  /** ms since epoch. */
  at: number;
  /** id of the Sable handoff this answers (peer → Sable). */
  inReplyTo?: string;
  body: { title?: string; text?: string; status?: "done" | "failed" | "partial"; links?: string[] };
};

export const ERRORS = {
  bad_request: 400,
  bad_signature: 401,
  stale_timestamp: 401,
  bridge_off: 403,
  replay: 409,
  too_large: 413,
  bad_schema: 422,
  rate_limited: 429,
} as const;
export type ErrorCode = keyof typeof ERRORS;

const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const ID_RE = /^[A-Za-z0-9_.:-]{6,80}$/;

export const newNonce = () => randomBytes(18).toString("base64url");
export const newId = (prefix = "brg") => `${prefix}_${Date.now().toString(36)}_${randomBytes(6).toString("hex")}`;

export function signingString(ts: string | number, nonce: string, body: string) {
  return `${SCHEMA}:${ts}:${nonce}:${body}`;
}
export function sign(secret: string, ts: string | number, nonce: string, body: string) {
  return createHmac("sha256", secret).update(signingString(ts, nonce, body)).digest("hex");
}

/** Headers for an outbound request (no secret in them). */
export function signedHeaders(secret: string, body: string, now = Date.now(), nonce = newNonce()): Record<string, string> {
  const ts = String(Math.floor(now / 1000));
  return { "content-type": "application/json", [H_TS]: ts, [H_NONCE]: nonce, [H_SIG]: `v1=${sign(secret, ts, nonce, body)}` };
}

export type VerifyResult = { ok: true; ts: number; nonce: string } | { ok: false; code: ErrorCode; message: string };

/** Constant-time signature check + timestamp window. Does not check nonce reuse (see NonceCache). */
export function verify(secret: string, body: string, headers: { sig?: string | null; ts?: string | null; nonce?: string | null }, now = Date.now()): VerifyResult {
  const sig = (headers.sig ?? "").trim();
  const tsRaw = (headers.ts ?? "").trim();
  const nonce = (headers.nonce ?? "").trim();
  const m = /^v1=([0-9a-f]{64})$/i.exec(sig);
  if (!secret || !m || !/^\d{9,11}$/.test(tsRaw) || !NONCE_RE.test(nonce)) {
    timingSafeEqual(Buffer.alloc(32), Buffer.alloc(32));
    return { ok: false, code: "bad_signature", message: "missing or malformed signature headers" };
  }
  const expected = Buffer.from(sign(secret, tsRaw, nonce, body), "hex");
  const given = Buffer.from(m[1]!.toLowerCase(), "hex");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, code: "bad_signature", message: "signature mismatch" };
  const ts = Number(tsRaw);
  if (Math.abs(now / 1000 - ts) > WINDOW_S) return { ok: false, code: "stale_timestamp", message: `timestamp outside ±${WINDOW_S}s window` };
  return { ok: true, ts, nonce };
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);

export function parseMessage(raw: unknown, allowed: readonly string[]): { ok: true; msg: BridgeMessage } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "body must be a JSON object" };
  const o = raw as Record<string, unknown>;
  if (o.schema !== SCHEMA) return { ok: false, error: `schema must be ${SCHEMA}` };
  if (typeof o.id !== "string" || !ID_RE.test(o.id)) return { ok: false, error: "bad id" };
  if (typeof o.type !== "string" || !allowed.includes(o.type)) return { ok: false, error: `type must be one of ${allowed.join(", ")}` };
  if (typeof o.at !== "number" || !Number.isFinite(o.at)) return { ok: false, error: "bad at" };
  if (o.inReplyTo !== undefined && (typeof o.inReplyTo !== "string" || !ID_RE.test(o.inReplyTo))) return { ok: false, error: "bad inReplyTo" };
  const b = o.body;
  if (!b || typeof b !== "object" || Array.isArray(b)) return { ok: false, error: "body.body must be an object" };
  const body = b as Record<string, unknown>;
  const status = body.status === "done" || body.status === "failed" || body.status === "partial" ? body.status : undefined;
  const links = Array.isArray(body.links) ? body.links.filter((x): x is string => typeof x === "string" && /^https?:\/\//.test(x)).slice(0, 20).map((x) => x.slice(0, 2000)) : undefined;
  return {
    ok: true,
    msg: {
      schema: SCHEMA,
      id: o.id,
      type: o.type as BridgeType,
      from: o.from === "sable" ? "sable" : "peer",
      at: o.at,
      ...(typeof o.inReplyTo === "string" ? { inReplyTo: o.inReplyTo } : {}),
      body: { title: str(body.title, MAX_TITLE), text: str(body.text, MAX_TEXT), ...(status ? { status } : {}), ...(links?.length ? { links } : {}) },
    },
  };
}

export function makeMessage(type: BridgeType, body: BridgeMessage["body"], extra: { id?: string; at?: number; inReplyTo?: string; from?: "sable" | "peer" } = {}): BridgeMessage {
  return { schema: SCHEMA, id: extra.id ?? newId(), type, from: extra.from ?? "sable", at: extra.at ?? Date.now(), ...(extra.inReplyTo ? { inReplyTo: extra.inReplyTo } : {}), body };
}

/** Accept-once cache for nonces / message ids inside the replay window (in memory; window bounds it). */
export class NonceCache {
  private seen = new Map<string, number>();
  private ttlMs: number;
  private max: number;
  constructor(ttlMs = WINDOW_S * 2 * 1000, max = 5000) {
    this.ttlMs = ttlMs;
    this.max = max;
  }
  /** true = first time (now remembered); false = replay. */
  claim(key: string, now = Date.now()): boolean {
    const exp = this.seen.get(key);
    if (exp !== undefined && exp > now) return false;
    this.seen.set(key, now + this.ttlMs);
    if (this.seen.size > this.max) {
      for (const [k, e] of this.seen) if (e <= now) this.seen.delete(k);
      while (this.seen.size > this.max) this.seen.delete(this.seen.keys().next().value as string);
    }
    return true;
  }
  has(key: string, now = Date.now()) {
    const e = this.seen.get(key);
    return e !== undefined && e > now;
  }
  get size() {
    return this.seen.size;
  }
}

export class SlidingLimiter {
  private hits: number[] = [];
  private windowMs: number;
  private maxHits: number;
  constructor(windowMs = 60_000, maxHits = 30) {
    this.windowMs = windowMs;
    this.maxHits = maxHits;
  }
  allow(now = Date.now()) {
    this.hits = this.hits.filter((t) => now - t < this.windowMs);
    if (this.hits.length >= this.maxHits) return false;
    this.hits.push(now);
    return true;
  }
}
