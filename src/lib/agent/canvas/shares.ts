/**
 * W2c revocable canvas share links. Owner-created, read-only, expiring.
 * The token (32 random bytes, base64url) is shown once at creation; only its
 * SHA-256 is stored. Lookups are by hash, so a wrong/expired/revoked token is
 * indistinguishable (always "not found").
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { writeAtomic } from "../jobs/db.ts";

export const SHARE_TTL_HOURS = { min: 1, max: 24 * 30, default: 24 * 7 } as const;
export const MAX_ACTIVE_SHARES = 100;
const KEEP_DEAD_MS = 30 * 86_400_000;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export type CanvasShare = {
  id: string;
  canvasId: string;
  /** Pinned version, or null → always the latest version. */
  version: number | null;
  createdAt: number;
  expiresAt: number;
  revokedAt?: number;
  views: number;
  lastViewAt?: number;
  hash: string;
};
export type ShareView = Omit<CanvasShare, "hash"> & { state: "active" | "expired" | "revoked" };

export const validShareToken = (t: unknown): t is string => typeof t === "string" && TOKEN_RE.test(t);
const hashOf = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

export function shareOn(env: NodeJS.ProcessEnv = process.env) {
  return (env.SABLE_SHARE ?? "1").trim() !== "0";
}

export class ShareStore {
  private readonly file: string;
  private readonly now: () => number;
  constructor(dataDir: string, opts: { now?: () => number } = {}) {
    this.file = path.join(dataDir, "canvas-shares.json");
    this.now = opts.now ?? Date.now;
  }

  private load(): CanvasShare[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as { shares?: CanvasShare[] };
      return Array.isArray(raw.shares) ? raw.shares.filter((s) => s && typeof s.hash === "string" && /^[a-f0-9]{64}$/.test(s.hash)) : [];
    } catch {
      return [];
    }
  }

  private save(list: CanvasShare[]) {
    const now = this.now();
    const kept = list.filter((s) => (s.revokedAt ?? s.expiresAt) > now - KEEP_DEAD_MS);
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    writeAtomic(this.file, JSON.stringify({ shares: kept }, null, 2));
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      /* best effort */
    }
  }

  private view(s: CanvasShare): ShareView {
    const { hash: _h, ...rest } = s;
    return { ...rest, state: s.revokedAt ? "revoked" : s.expiresAt <= this.now() ? "expired" : "active" };
  }

  list(canvasId?: string): ShareView[] {
    return this.load()
      .filter((s) => !canvasId || s.canvasId === canvasId)
      .map((s) => this.view(s))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  create(input: { canvasId: string; version?: number | null; ttlHours?: number }): { ok: true; share: ShareView; token: string } | { ok: false; error: string } {
    const ttl = input.ttlHours ?? SHARE_TTL_HOURS.default;
    if (!Number.isFinite(ttl) || ttl < SHARE_TTL_HOURS.min || ttl > SHARE_TTL_HOURS.max) return { ok: false, error: `Thời hạn phải từ ${SHARE_TTL_HOURS.min} giờ đến ${SHARE_TTL_HOURS.max / 24} ngày.` };
    const version = input.version && Number.isInteger(input.version) && input.version > 0 ? input.version : null;
    const list = this.load();
    const now = this.now();
    if (list.filter((s) => !s.revokedAt && s.expiresAt > now).length >= MAX_ACTIVE_SHARES) return { ok: false, error: `Đã có ${MAX_ACTIVE_SHARES} link đang hoạt động; thu hồi bớt trước.` };
    const token = crypto.randomBytes(32).toString("base64url");
    const share: CanvasShare = { id: `sh_${crypto.randomBytes(6).toString("hex")}`, canvasId: input.canvasId, version, createdAt: now, expiresAt: now + Math.round(ttl * 3_600_000), views: 0, hash: hashOf(token) };
    list.push(share);
    this.save(list);
    return { ok: true, share: this.view(share), token };
  }

  revoke(id: string): ShareView | null {
    const list = this.load();
    const s = list.find((x) => x.id === id);
    if (!s) return null;
    s.revokedAt ??= this.now();
    this.save(list);
    return this.view(s);
  }

  /** Revoke every active link (optionally for one canvas). Returns the count. */
  revokeAll(canvasId?: string): number {
    const list = this.load();
    const now = this.now();
    let n = 0;
    for (const s of list)
      if (!s.revokedAt && (!canvasId || s.canvasId === canvasId)) {
        s.revokedAt = now;
        n++;
      }
    if (n) this.save(list);
    return n;
  }

  /** Resolve a presented token to an active share (and count the view), else null. */
  resolve(token: unknown, opts: { count?: boolean } = {}): ShareView | null {
    if (!validShareToken(token)) return null;
    const h = Buffer.from(hashOf(token), "hex");
    const list = this.load();
    const s = list.find((x) => crypto.timingSafeEqual(Buffer.from(x.hash, "hex"), h));
    if (!s || s.revokedAt || s.expiresAt <= this.now()) return null;
    if (opts.count) {
      s.views++;
      s.lastViewAt = this.now();
      this.save(list);
    }
    return this.view(s);
  }
}
