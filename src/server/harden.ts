/**
 * W2c hardening, applied to every request before TanStack Start (Vite connect
 * middleware in vite.config.ts). Pure + dependency-free so it is unit-tested.
 *
 *  - Rate limits per client IP (first X-Forwarded-For hop — ngrok sets it) on
 *    /api/* and the public share view /s/*. Loopback without XFF (local evals,
 *    the watchdog, the jobs-boot ping) is exempt. SABLE_RATE=0 turns it off.
 *  - Request size: Content-Length over the cap → 413 before any route runs
 *    (routes keep their own, smaller streaming caps).
 *  - CSRF: state-changing methods on /api/* need a same-origin / trusted Origin
 *    (or, without Origin, a Sec-Fetch-Site that is not cross-site). Exempt: the
 *    HMAC/secret-authenticated machine endpoints. SABLE_CSRF=0 turns it off.
 */

export type HardenRequest = { method: string; path: string; headers: Record<string, string | string[] | undefined>; remote?: string };
export type HardenVerdict = { ok: true } | { ok: false; status: 403 | 413 | 429; message: string; retryAfter?: number };

export type HardenConfig = {
  rateOn: boolean;
  csrfOn: boolean;
  /** Per minute per IP. */
  limits: { read: number; write: number; share: number };
  maxBody: number;
  trusted: string[];
};

const MINUTE = 60_000;
const WRITE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** Machine endpoints authenticated by HMAC / per-routine secret (no browser Origin). */
const CSRF_EXEMPT = [/^\/api\/channels\/webhook$/, /^\/api\/bridge\/inbound$/, /^\/api\/routines\/[A-Za-z0-9_-]{1,80}\/fire$/];

const num = (v: string | undefined, d: number, lo: number, hi: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? Math.floor(n) : d;
};

export function hardenConfig(env: Record<string, string | undefined> = process.env): HardenConfig {
  return {
    rateOn: (env.SABLE_RATE ?? "1").trim() !== "0",
    csrfOn: (env.SABLE_CSRF ?? "1").trim() !== "0",
    limits: {
      read: num(env.SABLE_RATE_READ, 600, 10, 100_000),
      write: num(env.SABLE_RATE_WRITE, 120, 5, 100_000),
      share: num(env.SABLE_RATE_SHARE, 60, 5, 100_000),
    },
    maxBody: num(env.SABLE_MAX_BODY, 10_000_000, 10_000, 100_000_000),
    trusted: (env.SABLE_TRUSTED_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        try {
          return new URL(s).origin;
        } catch {
          return "";
        }
      })
      .filter(Boolean),
  };
}

const h = (req: HardenRequest, name: string) => {
  const v = req.headers[name];
  return (Array.isArray(v) ? v[0] : v)?.trim() ?? "";
};

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/;

/** Client key: first XFF hop, else the socket address; null = exempt (loopback without proxy headers). */
export function clientKey(req: HardenRequest): string | null {
  const xff = h(req, "x-forwarded-for").split(",")[0]?.trim();
  if (xff) return xff.slice(0, 64);
  const remote = (req.remote ?? "").trim();
  if (!remote || LOOPBACK.test(remote)) return null;
  return remote.slice(0, 64);
}

export function originAllowed(req: HardenRequest, cfg: HardenConfig): boolean {
  const origin = h(req, "origin");
  if (!origin) {
    // No Origin (curl, server-to-server, old browsers): rely on Fetch Metadata when present.
    const site = h(req, "sec-fetch-site");
    return site === "" || site === "same-origin" || site === "none";
  }
  if (origin === "null") return false;
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  if (cfg.trusted.includes(o.origin)) return true;
  if ((o.hostname === "localhost" || o.hostname === "127.0.0.1") && o.protocol === "http:") return true;
  // Same origin as the Host header (ngrok keeps the public host). X-Forwarded-Host is ignored.
  const host = h(req, "host");
  return Boolean(host) && o.host === host.split(",")[0]!.trim();
}

export class Harden {
  private windows = new Map<string, { start: number; count: number }>();
  private readonly cfg: () => HardenConfig;
  private readonly now: () => number;
  constructor(cfg: () => HardenConfig = () => hardenConfig(), now: () => number = () => Date.now()) {
    this.cfg = cfg;
    this.now = now;
  }

  size() {
    return this.windows.size;
  }

  private hit(key: string, limit: number): number | null {
    const t = this.now();
    if (this.windows.size > 20_000) for (const [k, w] of this.windows) if (t - w.start >= MINUTE) this.windows.delete(k);
    const w = this.windows.get(key);
    if (!w || t - w.start >= MINUTE) {
      this.windows.set(key, { start: t, count: 1 });
      return null;
    }
    w.count += 1;
    return w.count > limit ? Math.max(1, Math.ceil((w.start + MINUTE - t) / 1000)) : null;
  }

  check(req: HardenRequest): HardenVerdict {
    const cfg = this.cfg();
    const path = req.path.split("?", 1)[0] ?? "";
    const method = req.method.toUpperCase();
    const api = path.startsWith("/api/");
    const share = path.startsWith("/s/");
    if (!api && !share) return { ok: true };
    const declared = Number(h(req, "content-length") || 0);
    if (declared > cfg.maxBody) return { ok: false, status: 413, message: "Yêu cầu quá lớn." };
    if (api && WRITE.has(method) && cfg.csrfOn && !CSRF_EXEMPT.some((re) => re.test(path)) && !originAllowed(req, cfg))
      return { ok: false, status: 403, message: "Origin không được phép (CSRF)." };
    if (cfg.rateOn) {
      const who = clientKey(req);
      if (who) {
        const cls = share ? "share" : WRITE.has(method) ? "write" : "read";
        const wait = this.hit(`${cls}|${who}`, cfg.limits[cls]);
        if (wait !== null) return { ok: false, status: 429, message: "Quá nhiều yêu cầu, thử lại sau.", retryAfter: wait };
      }
    }
    return { ok: true };
  }
}
