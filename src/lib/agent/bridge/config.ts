/** Bridge configuration: vault first (BRIDGE_PEER_URL, BRIDGE_SECRET, BRIDGE_PEER_TOKEN), env fallback. Never logged. */
export type BridgeConfig = {
  killed: boolean;
  url: string | null;
  secret: string | null;
  /** Optional bearer token the peer's webhook URL requires (sent as Authorization). */
  peerToken: string | null;
  /** Where each value came from (names only). */
  from: { url: "vault" | "env" | null; secret: "vault" | "env" | null; peerToken: "vault" | "env" | null };
  outboundReady: boolean;
  inboundReady: boolean;
  problems: string[];
};

export const VAULT_NAMES = { url: "BRIDGE_PEER_URL", secret: "BRIDGE_SECRET", peerToken: "BRIDGE_PEER_TOKEN" } as const;
export const ENV_NAMES = { url: "SABLE_BRIDGE_URL", secret: "SABLE_BRIDGE_SECRET", peerToken: "SABLE_BRIDGE_PEER_TOKEN" } as const;

export function bridgeConfig(env: Record<string, string | undefined>, vaultGet: (name: string) => string | null): BridgeConfig {
  const killed = (env.SABLE_BRIDGE ?? "").trim() === "0";
  const pick = (k: keyof typeof VAULT_NAMES) => {
    const v = vaultGet(VAULT_NAMES[k])?.trim();
    if (v) return { v, from: "vault" as const };
    const e = env[ENV_NAMES[k]]?.trim();
    if (e) return { v: e, from: "env" as const };
    return { v: null, from: null };
  };
  const url = pick("url");
  const secret = pick("secret");
  const tok = pick("peerToken");
  const problems: string[] = [];
  let urlOk = false;
  if (url.v) {
    try {
      const u = new URL(url.v);
      if (u.protocol !== "https:") problems.push("peer URL must be https");
      else if (u.username || u.password) problems.push("peer URL must not embed credentials");
      else urlOk = true;
    } catch {
      problems.push("peer URL is not a valid URL");
    }
  } else problems.push(`peer URL not set (vault ${VAULT_NAMES.url})`);
  let secretOk = false;
  if (!secret.v) problems.push(`shared secret not set (vault ${VAULT_NAMES.secret})`);
  else if (secret.v.length < 32) problems.push("shared secret must be ≥ 32 characters");
  else secretOk = true;
  return {
    killed,
    url: urlOk ? url.v : null,
    secret: secretOk ? secret.v : null,
    peerToken: tok.v,
    from: { url: url.from, secret: secret.from, peerToken: tok.from },
    outboundReady: !killed && urlOk && secretOk,
    inboundReady: !killed && secretOk,
    problems: killed ? ["SABLE_BRIDGE=0 (kill switch)"] : problems,
  };
}
