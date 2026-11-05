/**
 * W2b OAuth2 manager: authorization-code flow with PKCE (S256) + single-use
 * state, token refresh, revoke. Tokens live ONLY in the vault (SecretStore,
 * encrypted at rest); the non-secret meta file holds timestamps, granted
 * scopes and a sanitized last error. Nothing here logs or returns a token:
 * errors carry only an OAuth error code, never a response body.
 */
import fs from "node:fs";
import path from "node:path";
import { challengeOf, newState, newVerifier } from "./pkce.ts";
import {
  OAuthError,
  type ClientCreds,
  type ConnectorDef,
  type ConnectorStatus,
  type OAuthProvider,
  type SecretStore,
  type StoredToken,
} from "./types.ts";

export type OAuthDeps = {
  providers: Record<string, OAuthProvider>;
  connectors: ConnectorDef[];
  secrets: SecretStore;
  /** Client id/secret for a provider (from the vault or env), or null → not-configured. */
  creds(providerId: string): ClientCreds | null;
  /** `https://<public origin>/api/oauth/callback`, or null when no public origin is set. */
  redirectUri(): string | null;
  metaDir: string;
  fetch?: typeof fetch;
  now?: () => number;
  enabled?: () => boolean;
  /** Tests only: allow http:// on 127.0.0.1/localhost (mock server). */
  allowLoopbackHttp?: boolean;
};

type Meta = { connectedAt?: number; grantedScopes?: string[]; lastError?: string; lastErrorAt?: number; lastSyncAt?: number };
type Pending = { connectorId: string; verifier: string; createdAt: number; redirectUri: string };

const STATE_TTL_MS = 10 * 60_000;
const MAX_PENDING = 20;
const REFRESH_SKEW_MS = 60_000;
const TIMEOUT_MS = 15_000;
const META_FILE = "oauth.json";

export const tokenName = (connectorId: string) => `OAUTH_TOKEN_${connectorId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
export const OAUTH_SECRET_PREFIX = "OAUTH_TOKEN_";
/** W2c: pending sign-ins survive a restart — encrypted in the vault (same OAUTH_TOKEN_ prefix → not readable via /api/vault). */
export const PENDING_SECRET = "OAUTH_TOKEN_PENDING_STATES";

/** Only an RFC 6749 error code survives into messages/logs. */
function codeOf(body: unknown): string {
  const e = (body as { error?: unknown } | null)?.error;
  return typeof e === "string" && /^[a-z_]{1,40}$/.test(e) ? e : "unknown_error";
}

export class OAuthManager {
  private readonly d: OAuthDeps;
  private readonly pending = new Map<string, Pending>();
  private pendingLoaded = false;
  private refreshing = new Map<string, Promise<StoredToken>>();

  constructor(deps: OAuthDeps) {
    this.d = deps;
  }

  private now() {
    return this.d.now?.() ?? Date.now();
  }

  /** Load persisted pending states once (expired ones dropped). Best effort. */
  private loadPending() {
    if (this.pendingLoaded) return;
    this.pendingLoaded = true;
    try {
      if (!this.d.secrets.configured()) return;
      const raw = this.d.secrets.get(PENDING_SECRET);
      if (!raw) return;
      const list = JSON.parse(raw) as Array<[string, Pending]>;
      const now = this.now();
      let dropped = false;
      for (const [k, v] of Array.isArray(list) ? list : []) {
        if (typeof k !== "string" || !v || typeof v.connectorId !== "string" || typeof v.verifier !== "string" || typeof v.createdAt !== "number" || typeof v.redirectUri !== "string") continue;
        if (now - v.createdAt > STATE_TTL_MS || v.createdAt > now + 60_000) {
          dropped = true;
          continue;
        }
        if (!this.pending.has(k)) this.pending.set(k, v);
      }
      while (this.pending.size > MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
      if (dropped) this.savePending();
    } catch {
      // unreadable → start empty
    }
  }

  /** Write pending states (encrypted vault). No vault key → memory only (as before W2c). */
  private savePending() {
    try {
      if (!this.d.secrets.configured()) return;
      const now = this.now();
      for (const [k, v] of this.pending) if (now - v.createdAt > STATE_TTL_MS) this.pending.delete(k);
      if (!this.pending.size) this.d.secrets.remove(PENDING_SECRET);
      else this.d.secrets.put(PENDING_SECRET, JSON.stringify([...this.pending.entries()]));
    } catch {
      // best effort
    }
  }
  private on() {
    return this.d.enabled?.() ?? true;
  }
  private f() {
    return this.d.fetch ?? fetch;
  }

  connector(id: string): ConnectorDef {
    const c = this.d.connectors.find((x) => x.id === id);
    if (!c) throw new OAuthError("unknown_connector", `Không có connector ${id}.`);
    return c;
  }
  private provider(c: ConnectorDef): OAuthProvider {
    const p = this.d.providers[c.provider];
    if (!p) throw new OAuthError("unknown_provider", `Không có provider ${c.provider}.`);
    return p;
  }

  // ---- non-secret meta ----
  private metaPath() {
    return path.join(this.d.metaDir, META_FILE);
  }
  private readMeta(): Record<string, Meta> {
    try {
      const raw = JSON.parse(fs.readFileSync(this.metaPath(), "utf8"));
      return raw && typeof raw === "object" ? raw : {};
    } catch {
      return {};
    }
  }
  private patchMeta(id: string, patch: Meta | null) {
    const all = this.readMeta();
    if (patch === null) delete all[id];
    else all[id] = { ...all[id], ...patch };
    fs.mkdirSync(this.d.metaDir, { recursive: true, mode: 0o700 });
    const tmp = `${this.metaPath()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.metaPath());
  }
  private fail(id: string, code: string, message: string): never {
    this.patchMeta(id, { lastError: `${code}: ${message}`.slice(0, 200), lastErrorAt: this.now() });
    throw new OAuthError(code, message);
  }
  markSynced(id: string) {
    this.patchMeta(id, { lastSyncAt: this.now() });
  }

  // ---- token storage (vault only) ----
  private load(id: string): StoredToken | null {
    const raw = this.d.secrets.get(tokenName(id));
    if (!raw) return null;
    try {
      const t = JSON.parse(raw) as StoredToken;
      return typeof t.a === "string" && typeof t.e === "number" ? t : null;
    } catch {
      return null;
    }
  }
  private store(id: string, t: StoredToken) {
    const r = this.d.secrets.put(tokenName(id), JSON.stringify(t));
    if (!r.ok) this.fail(id, "vault_error", "Không lưu được token vào vault.");
  }

  hasToken(id: string) {
    return this.on() && this.load(id) !== null;
  }

  status(id: string): ConnectorStatus {
    const c = this.connector(id);
    const meta = this.readMeta()[id] ?? {};
    const base: ConnectorStatus = {
      id: c.id,
      label: c.label,
      provider: c.provider,
      description: c.description,
      status: "needs-auth",
      scopes: c.scopes,
      ...(meta.grantedScopes ? { grantedScopes: meta.grantedScopes } : {}),
      ...(meta.connectedAt ? { connectedAt: meta.connectedAt } : {}),
      ...(meta.lastError ? { lastError: meta.lastError, lastErrorAt: meta.lastErrorAt } : {}),
      ...(meta.lastSyncAt ? { lastSyncAt: meta.lastSyncAt } : {}),
    };
    if (!this.on()) return { ...base, status: "off", reason: "SABLE_OAUTH=0" };
    if (!this.d.secrets.configured()) return { ...base, status: "not-configured", reason: "Vault chưa có SABLE_VAULT_KEY — token chỉ được lưu trong vault." };
    if (!this.d.creds(c.provider)) return { ...base, status: "not-configured", reason: `Thiếu OAuth client của ${this.provider(c).label} (needs He's credentials — xem docs/OAUTH-SETUP.md).` };
    if (!this.d.redirectUri()) return { ...base, status: "not-configured", reason: "Thiếu public origin cho redirect URI (SABLE_OAUTH_REDIRECT_BASE / SABLE_TRUSTED_ORIGINS)." };
    const tok = this.load(id);
    if (tok) return { ...base, status: "connected" };
    if (meta.lastError && (meta.lastErrorAt ?? 0) > (meta.connectedAt ?? 0)) return { ...base, status: "error", reason: "Kết nối lỗi — bấm Connect để cấp quyền lại." };
    return { ...base, status: "needs-auth", reason: "Bấm Connect để cấp quyền." };
  }

  list(): ConnectorStatus[] {
    return this.d.connectors.map((c) => this.status(c.id));
  }

  // ---- outbound HTTP (allow-listed) ----
  private checkUrl(url: string, allowed: string[]) {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new OAuthError("bad_url", "URL không hợp lệ.");
    }
    const loop = u.hostname === "127.0.0.1" || u.hostname === "localhost";
    if (u.protocol !== "https:" && !(this.d.allowLoopbackHttp && loop && u.protocol === "http:")) throw new OAuthError("insecure_url", "Chỉ cho phép https.");
    if (u.username || u.password) throw new OAuthError("bad_url", "URL không được có thông tin đăng nhập.");
    if (!allowed.some((p) => url.startsWith(p))) throw new OAuthError("host_not_allowed", `Host ${u.host} không nằm trong danh sách cho phép.`);
  }

  private async post(url: string, form: Record<string, string>) {
    const res = await this.f()(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(form).toString(),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { res, body };
  }

  // ---- authorization-code flow ----
  begin(id: string): { url: string; state: string } {
    if (!this.on()) throw new OAuthError("disabled", "OAuth đang tắt (SABLE_OAUTH=0).");
    const st = this.status(id);
    if (st.status === "not-configured" || st.status === "off") throw new OAuthError("not_configured", st.reason ?? "Chưa cấu hình.");
    const c = this.connector(id);
    const p = this.provider(c);
    const creds = this.d.creds(c.provider)!;
    const redirectUri = this.d.redirectUri()!;
    this.checkUrl(p.authUrl, [p.authUrl]);
    this.loadPending();
    const now = this.now();
    for (const [k, v] of this.pending) if (now - v.createdAt > STATE_TTL_MS) this.pending.delete(k);
    while (this.pending.size >= MAX_PENDING) this.pending.delete(this.pending.keys().next().value!);
    const state = newState();
    const verifier = newVerifier();
    this.pending.set(state, { connectorId: id, verifier, createdAt: now, redirectUri });
    this.savePending();
    const u = new URL(p.authUrl);
    const q = u.searchParams;
    q.set("response_type", "code");
    q.set("client_id", creds.clientId);
    q.set("redirect_uri", redirectUri);
    q.set("scope", c.scopes.join(" "));
    q.set("state", state);
    q.set("code_challenge", challengeOf(verifier));
    q.set("code_challenge_method", "S256");
    for (const [k, v] of Object.entries(p.authParams ?? {})) q.set(k, v);
    return { url: u.toString(), state };
  }

  /** Callback: single-use state, then code → tokens (stored in the vault only). */
  async complete(params: { state?: string | null; code?: string | null; error?: string | null }): Promise<{ connectorId: string }> {
    if (!this.on()) throw new OAuthError("disabled", "OAuth đang tắt (SABLE_OAUTH=0).");
    const state = params.state ?? "";
    this.loadPending();
    const pend = state ? this.pending.get(state) : undefined;
    if (!pend) throw new OAuthError("invalid_state", "state không hợp lệ hoặc đã dùng.");
    this.pending.delete(state);
    this.savePending();
    if (this.now() - pend.createdAt > STATE_TTL_MS) throw new OAuthError("expired_state", "Phiên cấp quyền đã hết hạn — thử lại.");
    const id = pend.connectorId;
    if (params.error) this.fail(id, /^[a-z_]{1,40}$/.test(params.error) ? params.error : "denied", "Người dùng từ chối hoặc provider báo lỗi.");
    const code = params.code ?? "";
    if (!code || code.length > 2048) this.fail(id, "invalid_request", "Thiếu code.");
    const c = this.connector(id);
    const p = this.provider(c);
    const creds = this.d.creds(c.provider);
    if (!creds) this.fail(id, "not_configured", "Thiếu OAuth client.");
    this.checkUrl(p.tokenUrl, [p.tokenUrl]);
    const form: Record<string, string> = {
      grant_type: "authorization_code",
      code,
      redirect_uri: pend.redirectUri,
      client_id: creds.clientId,
      code_verifier: pend.verifier,
    };
    if (creds.clientSecret) form.client_secret = creds.clientSecret;
    const { res, body } = await this.post(p.tokenUrl, form).catch(() => this.fail(id, "network_error", "Không gọi được token endpoint."));
    const b = body as Record<string, unknown> | null;
    if (!res.ok || !b || typeof b.access_token !== "string") this.fail(id, codeOf(body), `Đổi code lấy token thất bại (HTTP ${res.status}).`);
    const tok: StoredToken = {
      a: b.access_token as string,
      ...(typeof b.refresh_token === "string" ? { r: b.refresh_token } : {}),
      e: this.now() + (Number(b.expires_in) > 0 ? Number(b.expires_in) * 1000 : 3_600_000),
      ...(typeof b.scope === "string" ? { s: b.scope } : {}),
      ...(typeof b.token_type === "string" ? { t: b.token_type } : {}),
    };
    this.store(id, tok);
    this.patchMeta(id, { connectedAt: this.now(), grantedScopes: (tok.s ?? c.scopes.join(" ")).split(/\s+/).filter(Boolean), lastError: undefined, lastErrorAt: undefined });
    return { connectorId: id };
  }

  private async refresh(id: string, tok: StoredToken): Promise<StoredToken> {
    const inflight = this.refreshing.get(id);
    if (inflight) return inflight;
    const run = (async () => {
      if (!tok.r) {
        this.d.secrets.remove(tokenName(id));
        this.fail(id, "no_refresh_token", "Token hết hạn và không có refresh token — Connect lại.");
      }
      const c = this.connector(id);
      const p = this.provider(c);
      const creds = this.d.creds(c.provider);
      if (!creds) this.fail(id, "not_configured", "Thiếu OAuth client.");
      this.checkUrl(p.tokenUrl, [p.tokenUrl]);
      const form: Record<string, string> = { grant_type: "refresh_token", refresh_token: tok.r!, client_id: creds.clientId };
      if (creds.clientSecret) form.client_secret = creds.clientSecret;
      const { res, body } = await this.post(p.tokenUrl, form).catch(() => this.fail(id, "network_error", "Không gọi được token endpoint."));
      const b = body as Record<string, unknown> | null;
      if (!res.ok || !b || typeof b.access_token !== "string") {
        const code = codeOf(body);
        if (code === "invalid_grant") this.d.secrets.remove(tokenName(id));
        this.fail(id, code, `Làm mới token thất bại (HTTP ${res.status}).`);
      }
      const next: StoredToken = {
        ...tok,
        a: b.access_token as string,
        ...(typeof b.refresh_token === "string" ? { r: b.refresh_token } : {}),
        e: this.now() + (Number(b.expires_in) > 0 ? Number(b.expires_in) * 1000 : 3_600_000),
        ...(typeof b.scope === "string" ? { s: b.scope } : {}),
      };
      this.store(id, next);
      return next;
    })();
    this.refreshing.set(id, run);
    try {
      return await run;
    } finally {
      this.refreshing.delete(id);
    }
  }

  /** A valid access token (refreshed when it expires within 60 s). Server-internal only. */
  private async access(id: string, force = false): Promise<string> {
    if (!this.on()) throw new OAuthError("disabled", "OAuth đang tắt (SABLE_OAUTH=0).");
    let tok = this.load(id);
    if (!tok) throw new OAuthError("needs_auth", `${this.connector(id).label} chưa kết nối.`);
    if (force || tok.e - this.now() < REFRESH_SKEW_MS) tok = await this.refresh(id, tok);
    return tok.a;
  }

  /** Authorized API call to one of the connector's allow-listed bases; one forced refresh on 401. */
  async request(id: string, url: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<{ status: number; json: unknown }> {
    const c = this.connector(id);
    this.checkUrl(url, c.apiBases);
    const call = async (token: string) =>
      this.f()(url, {
        method: init.method ?? "GET",
        headers: { Accept: "application/json", ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}), ...init.headers, Authorization: `Bearer ${token}` },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    let res = await call(await this.access(id));
    if (res.status === 401) res = await call(await this.access(id, true));
    let json: unknown = null;
    const text = await res.text();
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: res.status, json };
  }

  /** Revoke at the provider (best effort) and delete the token from the vault. */
  async revoke(id: string): Promise<{ revoked: boolean; removed: boolean }> {
    const c = this.connector(id);
    const p = this.provider(c);
    const tok = this.load(id);
    let revoked = false;
    if (tok && p.revokeUrl) {
      try {
        this.checkUrl(p.revokeUrl, [p.revokeUrl]);
        const { res } = await this.post(p.revokeUrl, { token: tok.r ?? tok.a });
        revoked = res.ok;
      } catch {
        revoked = false;
      }
    }
    const removed = this.d.secrets.remove(tokenName(id));
    this.patchMeta(id, null);
    return { revoked, removed };
  }

  pendingCount() {
    this.loadPending();
    return this.pending.size;
  }
}
