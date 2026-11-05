/** Bridge state on disk: `sable-data/bridge/{handoffs,inbound,settings}.json`, atomic 0600, capped. */
import fs from "node:fs";
import path from "node:path";
import type { OutType } from "./protocol.ts";

export type HandoffState = "pending" | "sending" | "sent" | "failed" | "rejected" | "expired";
export type Handoff = {
  id: string;
  at: number;
  kind: OutType;
  title: string;
  /** Redacted text exactly as it will be / was sent. */
  text: string;
  bytes: number;
  redactions: number;
  clipped: boolean;
  state: HandoffState;
  via: "panel" | "chat";
  initiator: { kind: string; id: string };
  target: "peer" | "mock";
  decidedAt?: number;
  sentAt?: number;
  status?: number;
  ms?: number;
  error?: string;
  replies: number;
};
export type InboundState = "open" | "resolved" | "dismissed";
export type InboundItem = {
  id: string;
  at: number;
  receivedAt: number;
  type: "result" | "message" | "pong";
  inReplyTo?: string;
  /** true when inReplyTo matches a handoff Sable actually sent. */
  matched: boolean;
  title: string;
  text: string;
  status?: string;
  links?: string[];
  state: InboundState;
  threadId?: string;
};
export type BridgeSettings = { inboundThreads: boolean };

const MAX_HANDOFFS = 300;
const MAX_INBOUND = 500;
export const PENDING_TTL_MS = 30 * 60_000;

export class BridgeStore {
  readonly dir: string;
  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "bridge");
  }
  private read<T>(name: string, d: T): T {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, name), "utf8")) as T;
    } catch {
      return d;
    }
  }
  private write(name: string, v: unknown) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const f = path.join(this.dir, name);
    const tmp = `${f}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(v), { mode: 0o600 });
    fs.renameSync(tmp, f);
  }
  handoffs(now = Date.now()): Handoff[] {
    const list = this.read<Handoff[]>("handoffs.json", []);
    let changed = false;
    for (const h of list)
      if (h.state === "pending" && now - h.at > PENDING_TTL_MS) {
        h.state = "expired";
        changed = true;
      }
    if (changed) this.write("handoffs.json", list);
    return list;
  }
  handoff(id: string) {
    return this.handoffs().find((h) => h.id === id) ?? null;
  }
  putHandoff(h: Handoff) {
    const list = this.handoffs().filter((x) => x.id !== h.id);
    list.unshift(h);
    this.write("handoffs.json", list.slice(0, MAX_HANDOFFS));
    return h;
  }
  patchHandoff(id: string, patch: Partial<Handoff>) {
    const list = this.handoffs();
    const h = list.find((x) => x.id === id);
    if (!h) return null;
    Object.assign(h, patch);
    this.write("handoffs.json", list);
    return h;
  }
  inbound(): InboundItem[] {
    return this.read<InboundItem[]>("inbound.json", []);
  }
  addInbound(it: InboundItem) {
    const list = this.inbound();
    list.unshift(it);
    this.write("inbound.json", list.slice(0, MAX_INBOUND));
    return it;
  }
  setInbound(id: string, state: InboundState) {
    const list = this.inbound();
    const it = list.find((x) => x.id === id);
    if (!it) return null;
    it.state = state;
    this.write("inbound.json", list);
    return it;
  }
  settings(): BridgeSettings {
    return { inboundThreads: false, ...this.read<Partial<BridgeSettings>>("settings.json", {}) };
  }
  setSettings(p: Partial<BridgeSettings>) {
    const next = { ...this.settings(), ...(typeof p.inboundThreads === "boolean" ? { inboundThreads: p.inboundThreads } : {}) };
    this.write("settings.json", next);
    return next;
  }
}
