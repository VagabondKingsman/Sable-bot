/** Browser client for the W6 bridge panel API. */
import { readError, withPrefix } from "@/lib/agent/client";
import type { Handoff, InboundItem, BridgeSettings } from "@/lib/agent/bridge/store";

export type { Handoff, InboundItem };
export type BridgeStatus = {
  killed: boolean;
  outboundReady: boolean;
  inboundReady: boolean;
  problems: string[];
  from: { url: string | null; secret: string | null; peerToken: string | null };
  peerHost: string | null;
  peerToken: boolean;
  settings: BridgeSettings;
  lastInboundAt: number | null;
  lastError: string | null;
  counts: { pending: number; sent: number; failed: number; inboundOpen: number };
  handoffs: Handoff[];
  inbound: InboundItem[];
  inboundPath: string;
};
export type MockPing = { ok: boolean; status: number; ms: number; pong: boolean; pongVerified: boolean; badSignatureStatus: number; peerReceived: number };

async function post<T>(body: Record<string, unknown>): Promise<T> {
  const res = await fetch(withPrefix("/api/bridge"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await readError(res, "Thao tác bridge thất bại."));
  return (await res.json()) as T;
}

export const bridgeApi = {
  status: async (signal?: AbortSignal) => {
    const res = await fetch(withPrefix("/api/bridge"), { signal, cache: "no-store" });
    if (!res.ok) throw new Error(await readError(res, "Không tải được bridge."));
    return (await res.json()) as BridgeStatus;
  },
  handoff: (kind: "task" | "question" | "ping", title: string, text: string) => post<{ handoff: Handoff }>({ action: "handoff", kind, title, text }),
  decide: (id: string, approve: boolean) => post<{ handoff: Handoff }>({ action: "decide", id, approve }),
  pingMock: () => post<MockPing>({ action: "ping_mock" }),
  inbound: (id: string, state: "resolved" | "dismissed" | "open") => post<{ ok: true }>({ action: "inbound", id, state }),
  settings: (inboundThreads: boolean) => post<{ settings: BridgeSettings }>({ action: "settings", inboundThreads }),
};
