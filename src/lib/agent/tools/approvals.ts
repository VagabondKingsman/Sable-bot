/**
 * Approval gate for write tools. The loop blocks on `request()` while the UI
 * shows Đồng ý / Từ chối; POST /api/tools resolves it. Times out → rejected.
 * In-memory: Sable is one server process and one user.
 */
import type { ClientEvent } from "../harness.ts";
import type { ApprovalAsk } from "./types.ts";

export const APPROVAL_TTL_MS = 120_000;

type Pending = { resolve: (ok: boolean) => void };

export type Approvals = {
  request(ask: ApprovalAsk, emit: (event: ClientEvent) => void, signal: AbortSignal): Promise<boolean>;
  decide(id: string, approve: boolean): boolean;
  pending(): number;
};

export function createApprovals(ttlMs = APPROVAL_TTL_MS, newId: () => string = () => crypto.randomUUID()): Approvals {
  const map = new Map<string, Pending>();
  return {
    request(ask, emit, signal) {
      // Already cancelled/timed out: never show (or wait on) a card nobody can act on.
      if (signal.aborted) return Promise.resolve(false);
      const id = newId();
      emit({ event: "approval", data: { id, tool: ask.tool, summary: ask.summary, preview: ask.preview, state: "pending" } });
      emit({ event: "status", data: { text: "Đang chờ bạn duyệt" } });
      return new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (ok: boolean, state: "approved" | "rejected" | "expired") => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          map.delete(id);
          if (!signal.aborted) emit({ event: "approval", data: { id, tool: ask.tool, summary: ask.summary, state } });
          resolve(ok);
        };
        const timer = setTimeout(() => finish(false, "expired"), ttlMs);
        (timer as { unref?: () => void }).unref?.(); // a pending ask alone must not keep a process alive
        const onAbort = () => finish(false, "rejected");
        signal.addEventListener("abort", onAbort, { once: true });
        map.set(id, { resolve: (ok) => finish(ok, ok ? "approved" : "rejected") });
      });
    },
    decide(id, approve) {
      const entry = map.get(id);
      if (!entry) return false;
      entry.resolve(approve);
      return true;
    },
    pending: () => map.size,
  };
}

const KEY = Symbol.for("sable.approvals");
export function sharedApprovals(): Approvals {
  const scope = globalThis as unknown as Record<symbol, Approvals | undefined>;
  scope[KEY] ??= createApprovals();
  return scope[KEY];
}
