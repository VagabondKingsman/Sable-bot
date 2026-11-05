/**
 * W2a proactive core, server side: triage feed over the in-app inbox
 * (job / routine results, approval asks) plus incoming channel events, and the
 * morning brief. Kill switches: SABLE_PROACTIVE=0 (all), SABLE_TRIAGE=0,
 * SABLE_BRIEF=0. Owner-only like every /api route; nothing here sends a
 * message except the opt-in brief to the owner's own inbox / Telegram.
 */
import { ProactiveStore } from "@/lib/agent/proactive/store";
import { buildFeed, counts, fromInbox, type TriagedItem } from "@/lib/agent/proactive/feed";
import type { TriageDeps, TriageInput } from "@/lib/agent/proactive/triage";
import type { ChatRequest } from "@/lib/agent/types";
import { dataDir } from "@/server/paths";
import { jobService } from "@/server/jobs.server";
import { prepareTurn } from "@/server/chat.server";
import { completerFor } from "@/server/memory.server";
import { composeBrief, dueSlot, type BriefTask } from "@/lib/agent/proactive/brief";
import type { BriefConfig, BriefRecord } from "@/lib/agent/proactive/store";
import type { InboxItem } from "@/lib/agent/jobs/types";
import { plannerBundle } from "@/server/planner.server";

const KEY = Symbol.for("sable.proactive.store");
type G = typeof globalThis & { [KEY]?: ProactiveStore };

export function proactiveOn() {
  return process.env.SABLE_PROACTIVE !== "0";
}
export function triageOn() {
  return proactiveOn() && process.env.SABLE_TRIAGE !== "0";
}
export function briefOn() {
  return proactiveOn() && process.env.SABLE_BRIEF !== "0";
}

export function proactiveStore(): ProactiveStore {
  const g = globalThis as G;
  return (g[KEY] ??= new ProactiveStore(dataDir()));
}

/** Light model completer, only when SABLE_MODEL_LIGHT names a model we can reach. */
export function lightTriageDeps(): TriageDeps {
  const model = process.env.SABLE_MODEL_LIGHT?.trim();
  const person = { name: process.env.SABLE_OWNER_NAME?.trim() || "the owner" };
  if (!model) return { person };
  const req: ChatRequest = {
    model,
    effort: "low",
    instructions: "",
    memory: "",
    messages: [],
    tools: { web: false, x: false, code: false, image: false },
    remember: false,
  };
  const complete = completerFor(() => prepareTurn({ ...req, messages: [{ role: "user", content: "triage" }] }));
  return {
    person,
    model,
    complete: (prompt, signal) => complete("You sort incoming items. Reply with one JSON object only.", prompt, signal),
  };
}

/** Record an incoming channel event so triage sees it. No-op when triage is off. */
export function recordIncoming(input: TriageInput) {
  if (!triageOn()) return;
  try {
    proactiveStore().addEvent(input);
  } catch {
    /* never break the channel on a store error */
  }
}

export function triageInputs(): TriageInput[] {
  const inbox = jobService().db.inbox().slice(0, 200).map(fromInbox);
  return [...inbox, ...proactiveStore().events().slice(0, 200)];
}

let lastFeed: { at: number; items: TriagedItem[] } | null = null;

export async function triageFeed(opts: { includeDone?: boolean } = {}) {
  if (!triageOn()) return { enabled: false, items: [] as TriagedItem[], counts: counts([]) };
  const items = await buildFeed(triageInputs(), proactiveStore(), lightTriageDeps());
  lastFeed = { at: Date.now(), items };
  const shown = opts.includeDone ? items : items.filter((it) => !it.state?.done);
  return { enabled: true, items: shown, counts: counts(items), model: process.env.SABLE_MODEL_LIGHT?.trim() || null };
}

export function lastTriage() {
  return lastFeed;
}

export function setItemState(id: string, action: "snooze" | "unsnooze" | "done" | "undone", untilMs?: number) {
  const store = proactiveStore();
  if (action === "snooze") return store.setState(id, { snoozedUntil: Date.now() + Math.min(Math.max(untilMs ?? 3_600_000, 60_000), 7 * 86_400_000) });
  if (action === "unsnooze") return store.setState(id, { snoozedUntil: undefined });
  if (action === "done") return store.setState(id, { done: true });
  return store.setState(id, { done: false });
}

// ── Morning brief ────────────────────────────────────────────────────────────


export const BRIEF_ROUTINE_ID = "builtin:morning-brief";

function briefTasks(): BriefTask[] {
  try {
    return plannerBundle()
      .plans.list()
      .map((p) => ({
        id: p.id,
        goal: p.goal,
        status: p.status,
        done: p.steps.filter((s) => s.status === "done" || s.status === "skipped").length,
        total: p.steps.length,
        waiting: p.steps.filter((s) => s.status === "waiting_approval").length,
      }));
  } catch {
    return [];
  }
}

function briefBudget() {
  try {
    const { budget } = plannerBundle();
    const t = budget.totals();
    const caps = budget.caps();
    return { totalTokens: t.totalTokens, usd: t.usd, maxTokens: caps.maxTokens, maxUsd: caps.maxUsd };
  } catch {
    return null;
  }
}

export async function previewBrief(now = new Date()) {
  const cfg = proactiveStore().brief();
  const feed = await triageFeed();
  const approvals = feed.items
    .filter((it) => it.result.bucket === "needs_approval")
    .map((it) => ({ id: it.input.meta?.approvalId ?? it.input.id, title: it.input.title, summary: it.input.body.replace(/^Cần duyệt:\s*/, "") }));
  return composeBrief({ now, tz: cfg.tz, triaged: feed.items, approvals, tasks: briefTasks(), budget: briefBudget(), since: cfg.lastRunAt ?? now.getTime() - 86_400_000 });
}

/** Compose + deliver to the in-app inbox (and the owner's Telegram when configured). */
export async function runBrief(opts: { manual: boolean; slot?: string; now?: Date }) {
  if (!briefOn()) return { ok: false as const, error: "Bản tin đang tắt (SABLE_BRIEF=0)." };
  const now = opts.now ?? new Date();
  const store = proactiveStore();
  const cfg = store.brief();
  const brief = await previewBrief(now);
  const id = `brf_${now.getTime().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const item: InboxItem = { id, kind: "brief", jobId: "", routineId: BRIEF_ROUTINE_ID, title: brief.title, status: "done", snippet: brief.text.slice(0, 240), createdAt: now.getTime(), read: false };
  const { db } = jobService();
  db.saveInbox([item, ...db.inbox()]);
  const delivered = ["inbox"];
  if (cfg.telegram) {
    const { notifyOwnerTelegram } = await import("@/server/channels.server");
    if (await notifyOwnerTelegram(brief.text)) delivered.push("telegram");
  }
  const record: BriefRecord = { id, at: now.getTime(), title: brief.title, text: brief.text, manual: opts.manual, delivered, counts: brief.counts };
  store.addBrief(record);
  store.setBrief({ lastRunAt: now.getTime(), ...(opts.slot ? { lastSlot: opts.slot } : {}) });
  onBriefDelivered?.(record, opts.manual);
  return { ok: true as const, brief: record };
}

/** Hook for the audit log (set by audit.server) — keeps this module free of a cycle. */
export let onBriefDelivered: ((record: BriefRecord, manual: boolean) => void) | undefined;
export function setBriefHook(fn: typeof onBriefDelivered) {
  onBriefDelivered = fn;
}

export function briefView() {
  const cfg = proactiveStore().brief();
  return { enabled: briefOn(), config: cfg, routineId: BRIEF_ROUTINE_ID, history: proactiveStore().briefs().slice(0, 10) };
}

export function updateBrief(patch: Partial<BriefConfig>) {
  const { enabled, time, tz, telegram } = patch;
  return proactiveStore().setBrief({ enabled, time, tz, telegram });
}

const TICK = Symbol.for("sable.proactive.briefTicker");
type GT = typeof globalThis & { [TICK]?: ReturnType<typeof setInterval> };

/** One-minute ticker: fires the brief once per local day at/after its time. */
export function startBriefTicker(intervalMs = 60_000) {
  const g = globalThis as GT;
  if (g[TICK]) return;
  let busy = false;
  g[TICK] = setInterval(() => {
    if (busy || !briefOn()) return;
    const slot = dueSlot(proactiveStore().brief(), new Date());
    if (!slot) return;
    busy = true;
    // Mark the slot first so a crash mid-run cannot fire twice.
    proactiveStore().setBrief({ lastSlot: slot });
    void runBrief({ manual: false, slot })
      .catch((error) => console.warn(`[sable-brief] failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        busy = false;
      });
  }, intervalMs);
  g[TICK].unref?.();
}
