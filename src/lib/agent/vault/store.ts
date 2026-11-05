/**
 * Encrypted-at-rest secrets under dataDir/vault.json (0600).
 * list() returns names only — never values. get() for runtime inject only.
 */
import fs from "node:fs";
import path from "node:path";
import { open, resolveMasterKey, seal, vaultOn, type Sealed } from "./crypto.ts";

const FILE = "vault.json";
const NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

export type VaultMeta = { names: string[]; configured: boolean; enabled: boolean; killed: boolean };

type Disk = { version: 1; entries: Record<string, Sealed> };

function empty(): Disk {
  return { version: 1, entries: {} };
}

function load(dir: string): Disk {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, FILE), "utf8")) as Disk;
    if (raw?.version !== 1 || !raw.entries || typeof raw.entries !== "object") return empty();
    return raw;
  } catch {
    return empty();
  }
}

function save(dir: string, disk: Disk) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(disk), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* ignore */
  }
}

export class VaultStore {
  private readonly dir: string;
  private readonly env: NodeJS.ProcessEnv;
  constructor(dir: string, env: NodeJS.ProcessEnv = process.env) {
    this.dir = dir;
    this.env = env;
  }

  enabled() {
    return vaultOn(this.env);
  }

  killed() {
    return !this.enabled();
  }

  private key() {
    return resolveMasterKey(this.env);
  }

  meta(): VaultMeta {
    const disk = load(this.dir);
    return {
      names: Object.keys(disk.entries).sort(),
      configured: Boolean(this.key()),
      enabled: this.enabled(),
      killed: this.killed(),
    };
  }

  list(): string[] {
    return this.meta().names;
  }

  put(name: string, value: string): { ok: true } | { ok: false; error: string } {
    if (!this.enabled()) return { ok: false, error: "vault off (SABLE_VAULT=0)" };
    if (!NAME_RE.test(name)) return { ok: false, error: "name must match [A-Z][A-Z0-9_]{1,63}" };
    if (typeof value !== "string" || value.length < 1 || value.length > 8_192)
      return { ok: false, error: "value length 1..8192" };
    const key = this.key();
    if (!key) return { ok: false, error: "SABLE_VAULT_KEY not set" };
    const disk = load(this.dir);
    disk.entries[name] = seal(value, key);
    save(this.dir, disk);
    return { ok: true };
  }

  /** Runtime only — callers must not log the result. */
  get(name: string): string | null {
    if (!this.enabled()) return null;
    if (!NAME_RE.test(name)) return null;
    const key = this.key();
    if (!key) return null;
    const sealed = load(this.dir).entries[name];
    if (!sealed) return null;
    try {
      return open(sealed, key);
    } catch {
      return null;
    }
  }

  remove(name: string): boolean {
    if (!this.enabled()) return false;
    const disk = load(this.dir);
    if (!(name in disk.entries)) return false;
    delete disk.entries[name];
    save(this.dir, disk);
    return true;
  }
}

/** Mask known vault names + generic secret patterns in tool/log output. */
export function redactVaultNames(text: string, names: string[]): string {
  let out = text;
  for (const name of names) {
    if (!name) continue;
    const re = new RegExp(`\\b${name}\\b\\s*[:=]\\s*(\\S+)`, "g");
    out = out.replace(re, `${name}=[đã ẩn]`);
  }
  return out;
}
