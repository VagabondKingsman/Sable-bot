import { assertReadyForAct } from "@/lib/agent/scope/guard";
import { ScopeStore } from "@/lib/agent/scope/store";
import { dataDir } from "@/server/paths";

const KEY = Symbol.for("sable.scope.v1");

export function scopeStore(): ScopeStore {
  const scope = globalThis as unknown as Record<symbol, ScopeStore | undefined>;
  if (!scope[KEY]) scope[KEY] = new ScopeStore(dataDir());
  return scope[KEY]!;
}

/** Bind a ScopeGate checker for ToolContext.assertScope. */
export function makeAssertScope(scopeId: string | null | undefined, mode: "interactive" | "background") {
  const store = scopeStore();
  return (tool: string, requiresScope: boolean) => {
    const decision = assertReadyForAct(store, { scopeId, mode, requiresScope });
    if (!decision.ok) return { ok: false as const, reason: decision.reason };
    return { ok: true as const };
  };
}
