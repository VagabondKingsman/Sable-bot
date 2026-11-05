import fs from "node:fs";
import path from "node:path";
import type { ScopeRecord, ScopeStatus } from "./types.ts";

const FILE = "scopes.json";

type Disk = { version: 1; items: ScopeRecord[] };

function empty(): Disk {
  return { version: 1, items: [] };
}

function load(dir: string): Disk {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, FILE), "utf8")) as Disk;
    if (raw?.version !== 1 || !Array.isArray(raw.items)) return empty();
    return raw;
  } catch {
    return empty();
  }
}

function save(dir: string, disk: Disk) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(disk, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function newId() {
  return `scope_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function scopeOn(env: NodeJS.ProcessEnv = process.env): boolean {
  // Fail-closed when explicitly off: ACT denied. "On" means gate is enforced.
  return (env.SABLE_SCOPE ?? "1").trim() !== "0";
}

/**
 * SABLE_SCOPE=0 → deny-all ACT (fail-closed), not "disable gate".
 * When killed, assertReadyForAct always fails.
 */
export function scopeKillDenyAll(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.SABLE_SCOPE ?? "1").trim() === "0";
}

export class ScopeStore {
  private readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }

  list(): ScopeRecord[] {
    return load(this.dir).items.slice().sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): ScopeRecord | undefined {
    return load(this.dir).items.find((s) => s.id === id);
  }

  create(input: {
    target: string;
    purpose: string;
    owner: string;
    ttlMs?: number;
    networkProfile?: ScopeRecord["networkProfile"];
    notes?: string;
    now?: number;
  }): ScopeRecord {
    const now = input.now ?? Date.now();
    const ttl = Math.min(7 * 86_400_000, Math.max(60_000, input.ttlMs ?? 3_600_000));
    const rec: ScopeRecord = {
      id: newId(),
      target: input.target.trim().slice(0, 500),
      purpose: input.purpose.trim().slice(0, 2_000),
      owner: input.owner.trim().slice(0, 120) || "owner",
      createdAt: now,
      expiresAt: now + ttl,
      status: "pending",
      networkProfile: input.networkProfile ?? "authorized_target_only",
      notes: input.notes?.slice(0, 2_000),
    };
    const disk = load(this.dir);
    disk.items.push(rec);
    save(this.dir, disk);
    return rec;
  }

  decide(id: string, status: Extract<ScopeStatus, "approved" | "denied">, approvalId?: string, now = Date.now()): ScopeRecord | null {
    const disk = load(this.dir);
    const item = disk.items.find((s) => s.id === id);
    if (!item) return null;
    if (item.status !== "pending") return item;
    item.status = status;
    item.decidedAt = now;
    if (approvalId) item.approvalId = approvalId;
    save(this.dir, disk);
    return item;
  }

  /** Refresh expired flags on read. */
  refresh(now = Date.now()): void {
    const disk = load(this.dir);
    let changed = false;
    for (const item of disk.items) {
      if (item.status === "approved" && item.expiresAt <= now) {
        item.status = "expired";
        changed = true;
      }
    }
    if (changed) save(this.dir, disk);
  }
}
