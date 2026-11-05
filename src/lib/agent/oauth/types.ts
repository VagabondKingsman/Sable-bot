/** W2b: generic OAuth2 connector framework (types). No values here are secret. */

export type OAuthProvider = {
  id: string;
  label: string;
  authUrl: string;
  tokenUrl: string;
  revokeUrl?: string;
  /** Extra query params on the authorize URL (e.g. access_type=offline). */
  authParams?: Record<string, string>;
};

export type ConnectorDef = {
  id: string;
  label: string;
  provider: string;
  description: string;
  scopes: string[];
  /** URL prefixes this connector's API calls may reach (anything else is refused). */
  apiBases: string[];
};

export type ClientCreds = { clientId: string; clientSecret?: string };

export type ConnectorState = "off" | "not-configured" | "needs-auth" | "connected" | "error";

export type ConnectorStatus = {
  id: string;
  label: string;
  provider: string;
  description: string;
  status: ConnectorState;
  /** Why it is not connected / what to do (never contains a secret). */
  reason?: string;
  scopes: string[];
  grantedScopes?: string[];
  connectedAt?: number;
  lastError?: string;
  lastErrorAt?: number;
  lastSyncAt?: number;
};

/** The W0 vault, narrowed. Values never leave the server. */
export type SecretStore = {
  get(name: string): string | null;
  put(name: string, value: string): { ok: true } | { ok: false; error: string };
  remove(name: string): boolean;
  /** Vault on and SABLE_VAULT_KEY present. */
  configured(): boolean;
};

export type StoredToken = {
  /** access token */
  a: string;
  /** refresh token */
  r?: string;
  /** expires at (epoch ms) */
  e: number;
  /** granted scopes (space separated) */
  s?: string;
  t?: string;
};

export class OAuthError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
