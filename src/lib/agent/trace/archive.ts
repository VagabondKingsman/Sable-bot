/**
 * Trace archive: finished traces snapshotted to `<dataDir>/traces/<id>.json`
 * (0700 dir, 0600 files) so they outlive the job cap (300) and edited chats.
 * Retention: SABLE_TRACE_RETAIN_DAYS (default 14, never below 7).
 */
import fs from "node:fs";
import path from "node:path";
import { writeAtomic } from "../jobs/db.ts";
import { isFinal, validTraceId } from "./build.ts";
import type { Trace } from "./types.ts";

export const MIN_RETAIN_DAYS = 7;
export const DEFAULT_RETAIN_DAYS = 14;
export const MAX_ARCHIVED = 5_000;

export function retainDays(env: NodeJS.ProcessEnv = process.env) {
  const n = Number(env.SABLE_TRACE_RETAIN_DAYS);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_RETAIN_DAYS;
  return Math.max(MIN_RETAIN_DAYS, Math.min(365, Math.floor(n)));
}

export class TraceArchive {
  readonly dir: string;
  private index = new Map<string, number>();
  private loaded = false;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "traces");
  }

  private ensure() {
    if (this.loaded) return;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(this.dir, 0o700);
    } catch {
      /* ignore */
    }
    for (const name of fs.readdirSync(this.dir)) {
      if (name.endsWith(".tmp")) {
        fs.rmSync(path.join(this.dir, name), { force: true });
        continue;
      }
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -5);
      if (!validTraceId(id)) continue;
      try {
        this.index.set(id, fs.statSync(path.join(this.dir, name)).mtimeMs);
      } catch {
        /* ignore */
      }
    }
    this.loaded = true;
  }

  private file(id: string) {
    if (!validTraceId(id)) throw new Error("bad trace id");
    return path.join(this.dir, `${id}.json`);
  }

  /** Write a finished trace when it is new or changed. Returns true when written. */
  upsert(trace: Trace): boolean {
    if (!isFinal(trace) || !validTraceId(trace.id)) return false;
    this.ensure();
    const prev = this.get(trace.id);
    if (prev && prev.updatedAt === trace.updatedAt && prev.events.length === trace.events.length) return false;
    writeAtomic(this.file(trace.id), JSON.stringify(trace));
    this.index.set(trace.id, Date.now());
    return true;
  }

  get(id: string): Trace | null {
    if (!validTraceId(id)) return null;
    this.ensure();
    try {
      return JSON.parse(fs.readFileSync(this.file(id), "utf8")) as Trace;
    } catch {
      return null;
    }
  }

  ids() {
    this.ensure();
    return [...this.index.keys()];
  }

  list(): Trace[] {
    return this.ids()
      .map((id) => this.get(id))
      .filter((t): t is Trace => !!t);
  }

  /** Delete traces finished more than `days` ago; also cap the count. */
  prune(now = Date.now(), days = retainDays()): number {
    this.ensure();
    const cutoff = now - Math.max(MIN_RETAIN_DAYS, days) * 86_400_000;
    let removed = 0;
    const all = this.list().sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
    all.forEach((t, i) => {
      if ((t.finishedAt ?? t.updatedAt) < cutoff || i >= MAX_ARCHIVED) {
        fs.rmSync(this.file(t.id), { force: true });
        this.index.delete(t.id);
        removed += 1;
      }
    });
    return removed;
  }
}
