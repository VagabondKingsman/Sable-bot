/**
 * W2 trace service. Reuses existing step records (jobs, planner tasks, synced
 * chat threads) and snapshots finished ones into the archive so they are kept
 * >= 7 days. SABLE_TRACE=0 turns the API and archive off.
 */
import { TraceArchive, retainDays } from "@/lib/agent/trace/archive";
import { exportTrace, filterByTool, fromChat, fromJob, fromPlan, summarize, validTraceId } from "@/lib/agent/trace/build";
import type { Trace, TraceSource } from "@/lib/agent/trace/types";
import { jobService } from "@/server/jobs.server";
import { plannerBundle } from "@/server/planner.server";
import { deskChanges } from "@/server/desk.server";
import { dataDir } from "@/server/paths";

export const traceEnabled = () => process.env.SABLE_TRACE !== "0";

const KEY = Symbol.for("sable.trace.v1");
const PRUNE_EVERY_MS = 10 * 60_000;
type Holder = { archive: TraceArchive; dir: string; lastPrune: number };

function holder(): Holder {
  const scope = globalThis as unknown as Record<symbol, Holder | undefined>;
  const dir = dataDir();
  if (!scope[KEY] || scope[KEY]!.dir !== dir) scope[KEY] = { archive: new TraceArchive(dir), dir, lastPrune: 0 };
  return scope[KEY]!;
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (error) {
    console.error("[sable] trace source failed:", error instanceof Error ? error.message : error);
    return fallback;
  }
}

/** Live traces from current records. */
function liveTraces(): Trace[] {
  const out: Trace[] = [];
  out.push(...safe(() => jobService().db.listJobs().map(fromJob), []));
  out.push(...safe(() => plannerBundle().plans.list().map(fromPlan), []));
  out.push(
    ...safe(
      () =>
        deskChanges(0).threads.flatMap(({ thread, mtime }) =>
          thread.messages.map((m) => fromChat(thread.id, thread.title, m, mtime)).filter((t): t is Trace => !!t),
        ),
      [],
    ),
  );
  return out;
}

/** Live first, archive fills in what the live stores no longer hold. Archives finished live ones. */
function allTraces(): Trace[] {
  const h = holder();
  const now = Date.now();
  if (now - h.lastPrune > PRUNE_EVERY_MS) {
    h.lastPrune = now;
    safe(() => h.archive.prune(now, retainDays()), 0);
  }
  const live = liveTraces();
  const byId = new Map<string, Trace>();
  for (const t of live) {
    byId.set(t.id, t);
    safe(() => h.archive.upsert(t), false);
  }
  for (const t of safe(() => h.archive.list(), [] as Trace[])) if (!byId.has(t.id)) byId.set(t.id, t);
  return [...byId.values()].sort((a, b) => (b.startedAt ?? b.updatedAt) - (a.startedAt ?? a.updatedAt));
}

export type TraceQuery = { source?: string | null; tool?: string | null; q?: string | null; limit?: number };

export function listTraces(query: TraceQuery = {}) {
  const sources = new Set<TraceSource>(["chat", "job", "plan"]);
  let items = allTraces();
  if (query.source && sources.has(query.source as TraceSource)) items = items.filter((t) => t.source === query.source);
  if (query.tool) items = items.filter((t) => t.events.some((e) => e.tool === query.tool));
  if (query.q) {
    const q = query.q.toLowerCase().slice(0, 200);
    items = items.filter((t) => t.title.toLowerCase().includes(q) || t.events.some((e) => e.label.toLowerCase().includes(q)));
  }
  const tools = new Map<string, number>();
  for (const t of items) for (const [name, n] of Object.entries(t.stats.tools)) tools.set(name, (tools.get(name) ?? 0) + n);
  const limit = Math.max(1, Math.min(500, query.limit ?? 100));
  return {
    enabled: true,
    retainDays: retainDays(),
    total: items.length,
    tools: [...tools.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
    items: items.slice(0, limit).map(summarize),
  };
}

export function getTrace(id: string, opts: { tool?: string | null } = {}): Trace | null {
  if (!validTraceId(id)) return null;
  const live = liveTraces().find((t) => t.id === id);
  const trace = live ?? holder().archive.get(id);
  if (!trace) return null;
  if (live) safe(() => holder().archive.upsert(live), false);
  return opts.tool ? filterByTool(trace, opts.tool) : trace;
}

export function exportTraceById(id: string) {
  const trace = getTrace(id);
  return trace ? exportTrace(trace) : null;
}
