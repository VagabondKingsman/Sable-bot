/**
 * Webhook channel — inbound + outbound, HMAC-SHA256 authenticated, owner-only,
 * rate-limited, SSRF-guarded outbound URLs. Versioned JSON event schema (v1)
 * is the integration point for a future Sable web app. See docs/WEBHOOK-API.md.
 *
 * Fresh Sable code (not copied from AIC). Telegram stays the chat UI channel;
 * this is the machine-to-machine bus.
 */
import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { checkUrl, parseAllowlist } from "../tools/fetch.ts";
import type { ChannelAdapter, OutboundMessage } from "./types.ts";

export const WEBHOOK_SCHEMA_V = 1 as const;
export const MAX_BODY = 64_000;
export const MAX_TEXT = 16_000;
export const DEFAULT_RATE = { windowMs: 60_000, max: 30 };

export type WebhookEventType =
  | "message.in"
  | "message.out"
  | "job.result"
  | "job.approval"
  | "approval.response"
  | "ping"
  | "pong";

export type WebhookEvent = {
  v: typeof WEBHOOK_SCHEMA_V;
  type: WebhookEventType;
  id: string;
  at: number;
  channel: "webhook";
  /** Conversation / peer key the app uses to thread replies. */
  peerId?: string;
  /** Job / approval ids when relevant. */
  ref?: { jobId?: string; approvalId?: string; routineId?: string };
  payload: Record<string, unknown>;
};

export function makeEvent(
  type: WebhookEventType,
  payload: Record<string, unknown>,
  extra: Partial<Pick<WebhookEvent, "peerId" | "ref" | "id" | "at">> = {},
): WebhookEvent {
  return {
    v: WEBHOOK_SCHEMA_V,
    type,
    id: extra.id ?? `evt_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
    at: extra.at ?? Date.now(),
    channel: "webhook",
    peerId: extra.peerId,
    ref: extra.ref,
    payload,
  };
}

export function signBody(secret: string, body: string | Buffer): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/** Constant-time compare of hex digests (or `sha256=<hex>` forms). */
export function verifySignature(secret: string, body: string | Buffer, header: string | null | undefined): boolean {
  if (!secret || !header) {
    timingSafeEqual(Buffer.from("00"), Buffer.from("00"));
    return false;
  }
  const provided = header.trim().replace(/^sha256=/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(provided)) {
    timingSafeEqual(Buffer.from("00"), Buffer.from("00"));
    return false;
  }
  const expected = signBody(secret, body);
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(provided, "hex"));
  } catch {
    return false;
  }
}

export function parseEvent(raw: unknown): { ok: true; event: WebhookEvent } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Body must be a JSON object." };
  const o = raw as Record<string, unknown>;
  if (o.v !== 1) return { ok: false, error: "Unsupported schema version (need v=1)." };
  const type = o.type;
  if (typeof type !== "string" || !type) return { ok: false, error: "Missing type." };
  const allowed: WebhookEventType[] = ["message.in", "message.out", "job.result", "job.approval", "approval.response", "ping", "pong"];
  if (!allowed.includes(type as WebhookEventType)) return { ok: false, error: `Unknown type ${type}.` };
  if (typeof o.id !== "string" || o.id.length > 80) return { ok: false, error: "Bad id." };
  if (typeof o.at !== "number" || !Number.isFinite(o.at)) return { ok: false, error: "Bad at." };
  if (o.channel !== "webhook") return { ok: false, error: "channel must be webhook." };
  const payload = o.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return { ok: false, error: "Missing payload object." };
  return {
    ok: true,
    event: {
      v: 1,
      type: type as WebhookEventType,
      id: o.id,
      at: o.at,
      channel: "webhook",
      peerId: typeof o.peerId === "string" ? o.peerId.slice(0, 120) : undefined,
      ref: o.ref && typeof o.ref === "object" && !Array.isArray(o.ref) ? (o.ref as WebhookEvent["ref"]) : undefined,
      payload: payload as Record<string, unknown>,
    },
  };
}

export class RateLimiter {
  private hits: number[] = [];
  private windowMs: number;
  private max: number;
  constructor(windowMs = DEFAULT_RATE.windowMs, max = DEFAULT_RATE.max) {
    this.windowMs = windowMs;
    this.max = max;
  }
  allow(now = Date.now()) {
    this.hits = this.hits.filter((t) => now - t < this.windowMs);
    if (this.hits.length >= this.max) return false;
    this.hits.push(now);
    return true;
  }
}

export type WebhookConfig = {
  /** Shared HMAC secret (never logged). */
  secret: string;
  /** Optional outbound URL to push events to (SSRF-checked). */
  outboundUrl?: string;
  /** Fixed owner peer id — only this peer may send message.in / approval.response. */
  ownerPeerId?: string;
  rate?: { windowMs: number; max: number };
  fetchImpl?: typeof fetch;
  checkUrl?: typeof checkUrl;
  allow?: string[];
  fakeIpEgress?: boolean;
  onInbound?: (event: WebhookEvent) => Promise<WebhookEvent | void> | WebhookEvent | void;
};

const REPLAY_TTL_MS = 10 * 60_000;
const REPLAY_MAX = 2_000;

export class WebhookChannel implements ChannelAdapter {
  readonly id = "webhook" as const;
  readonly config: WebhookConfig;
  private readonly limiter: RateLimiter;
  /** Recently seen event ids -> expiry ms (replay protection). */
  private readonly seenIds = new Map<string, number>();
  sent = 0;
  received = 0;
  lastError = "";
  constructor(config: WebhookConfig) {
    this.config = config;
    this.limiter = new RateLimiter(config.rate?.windowMs, config.rate?.max);
  }

  private remember(id: string, now = Date.now()) {
    this.seenIds.set(id, now + REPLAY_TTL_MS);
    if (this.seenIds.size > REPLAY_MAX) {
      for (const [k, exp] of this.seenIds) {
        if (exp <= now) this.seenIds.delete(k);
        if (this.seenIds.size <= REPLAY_MAX) break;
      }
      while (this.seenIds.size > REPLAY_MAX) {
        const first = this.seenIds.keys().next().value;
        if (first === undefined) break;
        this.seenIds.delete(first);
      }
    }
  }

  private isReplay(id: string, now = Date.now()) {
    const exp = this.seenIds.get(id);
    if (exp === undefined) return false;
    if (exp <= now) {
      this.seenIds.delete(id);
      return false;
    }
    return true;
  }

  /** Verify + parse an inbound HTTP body. */
  async handleInbound(rawBody: string, signatureHeader: string | null): Promise<{ status: number; body: unknown }> {
    if (!verifySignature(this.config.secret, rawBody, signatureHeader)) {
      return { status: 401, body: { message: "Sai chữ ký HMAC." } };
    }
    if (!this.limiter.allow()) return { status: 429, body: { message: "Quá nhiều yêu cầu, thử lại sau." } };
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return { status: 400, body: { message: "JSON không hợp lệ." } };
    }
    const ev = parseEvent(parsed);
    if (!ev.ok) return { status: 422, body: { message: ev.error } };
    const now = Date.now();
    if (this.isReplay(ev.event.id, now)) {
      return { status: 409, body: { message: "Sự kiện trùng (replay) — id đã xử lý." } };
    }
    // Remember before handling so a crash mid-handler still rejects the retry.
    this.remember(ev.event.id, now);
    if (ev.event.type === "ping") {
      this.received += 1;
      return { status: 200, body: makeEvent("pong", { ok: true }, { peerId: ev.event.peerId }) };
    }
    // Owner-only for anything that drives Sable.
    if (["message.in", "approval.response"].includes(ev.event.type)) {
      const owner = this.config.ownerPeerId;
      if (owner && ev.event.peerId !== owner) return { status: 403, body: { message: "peerId không được phép." } };
      if (!ev.event.peerId) return { status: 422, body: { message: "Thiếu peerId." } };
    }
    this.received += 1;
    try {
      const reply = await this.config.onInbound?.(ev.event);
      return { status: 202, body: reply ?? { ok: true, id: ev.event.id } };
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return { status: 500, body: { message: "Xử lý sự kiện thất bại." } };
    }
  }

  async deliver(event: WebhookEvent): Promise<boolean> {
    const url = this.config.outboundUrl;
    if (!url) return false;
    try {
      const check = this.config.checkUrl ?? checkUrl;
      const allow = this.config.allow ?? parseAllowlist(process.env.SABLE_FETCH_ALLOW);
      const fakeIp = this.config.fakeIpEgress ?? process.env.SABLE_FETCH_FAKE_IP === "1";
      await check(url, allow, undefined, fakeIp);
      const body = JSON.stringify(event);
      const sig = signBody(this.config.secret, body);
      const fetchImpl = this.config.fetchImpl ?? fetch;
      const res = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-sable-signature": `sha256=${sig}`,
          "user-agent": "SableWebhook/1.0",
        },
        body,
        signal: AbortSignal.timeout(15_000),
        redirect: "manual",
      });
      if (res.status >= 300 && res.status < 400) {
        this.lastError = "outbound redirect refused";
        return false;
      }
      if (!res.ok) {
        this.lastError = `outbound HTTP ${res.status}`;
        await res.body?.cancel().catch(() => undefined);
        return false;
      }
      this.sent += 1;
      return true;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  async send(msg: OutboundMessage): Promise<void> {
    const type = msg.approvals?.length ? "job.approval" : "message.out";
    const event = makeEvent(
      type,
      {
        text: msg.text.slice(0, MAX_TEXT),
        approvals: msg.approvals?.map((a) => ({ id: a.id, summary: a.summary, preview: a.preview?.slice(0, 1_500) })),
      },
      { peerId: msg.peerId },
    );
    if (msg.approvals?.[0]) event.ref = { approvalId: msg.approvals[0].id };
    await this.deliver(event);
  }
}

export function webhookConfigFrom(env: Record<string, string | undefined>): { config: WebhookConfig | null; error?: string } {
  if ((env.SABLE_WEBHOOK ?? "1").trim() === "0") return { config: null };
  const secret = env.SABLE_WEBHOOK_SECRET?.trim();
  if (!secret) return { config: null };
  if (secret.length < 16) return { config: null, error: "SABLE_WEBHOOK_SECRET phải ≥ 16 ký tự." };
  const outboundUrl = env.SABLE_WEBHOOK_URL?.trim() || undefined;
  const ownerPeerId = env.SABLE_WEBHOOK_OWNER?.trim() || "owner";
  return { config: { secret, outboundUrl, ownerPeerId } };
}
