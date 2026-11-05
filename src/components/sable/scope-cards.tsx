import { Check, Shield, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { decideScope, fetchPendingScopes } from "@/lib/agent/client";

type ScopeItem = { id: string; target: string; purpose: string; status: string; expiresAt: number };

/** Pending ScopeGate approvals — same Đồng ý / Từ chối pattern as write tools. */
export function ScopeApprovalStrip() {
  const [items, setItems] = useState<ScopeItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await fetchPendingScopes(signal);
      setItems(next);
    } catch {
      /* ignore poll errors */
    }
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    void reload(ac.signal);
    const t = setInterval(() => void reload(), 2_000);
    return () => {
      ac.abort();
      clearInterval(t);
    };
  }, [reload]);

  if (!items.length) return null;

  async function decide(id: string, approve: boolean) {
    setBusy(id);
    try {
      await decideScope(id, approve);
      setItems((prev) => prev.filter((i) => i.id !== id));
    } catch {
      /* leave card; next poll refreshes */
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-2 px-3 pt-2" data-testid="scope-approval-strip">
      {items.map((item) => (
        <div key={item.id} className="rounded-2xl bg-surface p-3 shadow-ring" role="group" aria-label="Duyệt ScopeGate">
          <div className="flex items-center gap-2 text-sm">
            <Shield className="size-4 shrink-0 text-accent" />
            <span className="font-medium">Scope: {item.target.slice(0, 80)}</span>
          </div>
          <p className="mt-1 text-xs text-muted">scope_gate · {item.purpose.slice(0, 160)}</p>
          <pre className="mt-2 max-h-24 overflow-auto rounded-xl bg-bg px-3 py-2 text-xs text-muted whitespace-pre-wrap break-all">
            {`id=${item.id}\nexpires=${new Date(item.expiresAt).toISOString()}`}
          </pre>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={busy === item.id}
              onClick={() => void decide(item.id, true)}
              className="flex min-h-11 items-center gap-2 rounded-xl bg-accent px-3 text-sm text-ink disabled:opacity-40"
            >
              <Check className="size-4" />
              Đồng ý
            </button>
            <button
              type="button"
              disabled={busy === item.id}
              onClick={() => void decide(item.id, false)}
              className="flex min-h-11 items-center gap-2 rounded-xl px-3 text-sm text-muted shadow-ring hover:text-fg disabled:opacity-40"
            >
              <X className="size-4" />
              Từ chối
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
