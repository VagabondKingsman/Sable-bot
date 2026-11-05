/**
 * W2b: the OAuth connector manager for this server (Google: Gmail + Calendar).
 * Tokens: vault only (OAUTH_TOKEN_*). Client id/secret: vault
 * GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET, or env
 * SABLE_GOOGLE_CLIENT_ID / SABLE_GOOGLE_CLIENT_SECRET. Kill switch SABLE_OAUTH=0.
 */
import { OAuthManager } from "@/lib/agent/oauth/manager";
import type { SecretStore } from "@/lib/agent/oauth/types";
import { googleDefs } from "@/lib/agent/connectors/google";
import { vaultStore } from "@/server/vault.server";
import { dataDir } from "@/server/paths";

export const oauthOn = () => (process.env.SABLE_OAUTH ?? "1").trim() !== "0";

export const CALLBACK_PATH = "/api/oauth/callback";

/** `https://<public origin>/api/oauth/callback` — must be registered in Google Cloud Console. */
export function redirectUri(): string | null {
  const raw = (process.env.SABLE_OAUTH_REDIRECT_BASE || (process.env.SABLE_TRUSTED_ORIGINS ?? "").split(",")[0] || "").trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (u.protocol !== "https:" && !(local && u.protocol === "http:")) return null;
    return `${u.origin}${CALLBACK_PATH}`;
  } catch {
    return null;
  }
}

function vaultSecrets(): SecretStore {
  const v = vaultStore();
  return {
    get: (n) => v.get(n),
    put: (n, val) => v.put(n, val),
    remove: (n) => v.remove(n),
    configured: () => {
      const m = v.meta();
      return m.enabled && m.configured;
    },
  };
}

function googleCreds() {
  const v = vaultStore();
  const id = v.get("GOOGLE_OAUTH_CLIENT_ID") ?? process.env.SABLE_GOOGLE_CLIENT_ID?.trim() ?? "";
  const secret = v.get("GOOGLE_OAUTH_CLIENT_SECRET") ?? process.env.SABLE_GOOGLE_CLIENT_SECRET?.trim() ?? "";
  return id ? { clientId: id, ...(secret ? { clientSecret: secret } : {}) } : null;
}

const KEY = Symbol.for("sable.oauth.v1");

export function oauthManager(): OAuthManager {
  const g = globalThis as unknown as Record<symbol, OAuthManager | undefined>;
  if (!g[KEY]) {
    const google = googleDefs();
    g[KEY] = new OAuthManager({
      providers: { google: google.provider },
      connectors: google.connectors,
      secrets: vaultSecrets(),
      creds: (p) => (p === "google" ? googleCreds() : null),
      redirectUri,
      metaDir: dataDir(),
      enabled: oauthOn,
    });
  }
  return g[KEY]!;
}

export function connectorsView() {
  return {
    enabled: oauthOn(),
    redirectUri: redirectUri(),
    connectors: oauthManager().list(),
    setup: "docs/OAUTH-SETUP.md",
  };
}
