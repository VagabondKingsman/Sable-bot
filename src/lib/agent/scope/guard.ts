/**
 * Server-side ACT gate. Background jobs never bypass.
 * Inspired by reverse-skill scope-contract (MIT) — enforced in process, not prompt-only.
 */
import type { ScopeDecision, ScopeRecord } from "./types.ts";
import { scopeKillDenyAll, type ScopeStore } from "./store.ts";

export type ActContext = {
  /** Interactive chat may proceed without scope for non-target tools; ACT tools pass scopeId. */
  scopeId?: string | null;
  /** Background / routine / spawn must never skip. */
  mode: "interactive" | "background";
  /** When true, this tool touches a declared target and requires a valid scope. */
  requiresScope: boolean;
  now?: number;
  env?: NodeJS.ProcessEnv;
};

export function assertReadyForAct(store: ScopeStore, ctx: ActContext): ScopeDecision {
  const env = ctx.env ?? process.env;
  if (scopeKillDenyAll(env)) {
    return { ok: false, reason: "SABLE_SCOPE=0 (fail-closed: all ACT denied)" };
  }
  if (!ctx.requiresScope) return { ok: true, scope: stubOk() };
  store.refresh(ctx.now);
  if (!ctx.scopeId) {
    return { ok: false, reason: "ACT requires an owner-approved scope id" };
  }
  const scope = store.get(ctx.scopeId);
  if (!scope) return { ok: false, reason: "scope not found" };
  const now = ctx.now ?? Date.now();
  if (scope.status === "expired" || scope.expiresAt <= now) {
    return { ok: false, reason: "scope expired", scope: { ...scope, status: "expired" } };
  }
  if (scope.status === "pending") return { ok: false, reason: "scope pending owner approval", scope };
  if (scope.status === "denied") return { ok: false, reason: "scope denied by owner", scope };
  if (scope.status !== "approved") return { ok: false, reason: `scope status=${scope.status}`, scope };
  // Background never gets a free pass — still needs approved scope (already checked).
  if (ctx.mode === "background" && scope.status !== "approved") {
    return { ok: false, reason: "background ACT blocked without approved scope", scope };
  }
  return { ok: true, scope };
}

function stubOk(): ScopeRecord {
  return {
    id: "scope_none",
    target: "",
    purpose: "non-ACT",
    owner: "system",
    createdAt: 0,
    expiresAt: Number.MAX_SAFE_INTEGER,
    status: "approved",
  };
}

/** Log line for audit (no secrets). */
export function scopeAuditLine(decision: ScopeDecision, tool: string): string {
  if (decision.ok) return `scope_ok tool=${tool} id=${decision.scope.id} target=${decision.scope.target.slice(0, 80)}`;
  return `scope_deny tool=${tool} reason=${decision.reason} id=${decision.scope?.id ?? "-"}`;
}
