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
import { composeBrief, localParts, type BriefTask } from "@/lib/agent/proactive/brief";
import type { BriefConfig, BriefRecord } from "@/lib/agent/proactive/store";
import type { InboxItem } from "@/lib/agent/jobs/types";
import { plannerBundle } from "@/server/planner.server";
import { audit } from "@/server/audit.server";
import { stateCounts, unify } from "@/lib/agent/proactive/unify";
import { assertNoSend, chipsFor } from "@/lib/agent/proactive/chips";
import { initiatorFor } from "@/lib/agent/jobs/runner";

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
  const { todaysEvents } = await import("@/server/connectors.server");
  const events = await todaysEvents(now, cfg.tz);
  return composeBrief({ now, tz: cfg.tz, triaged: feed.items, approvals, tasks: briefTasks(), budget: briefBudget(), since: cfg.lastRunAt ?? now.getTime() - 86_400_000, events });
}

/** Compose + deliver to the in-app inbox (and the owner's Telegram when configured). */
export async function runBrief(opts: { manual: boolean; slot?: string; now?: Date }) {
  if (!briefOn()) return { ok: false as const, error: "Bản tin đang tắt (SABLE_BRIEF=0)." };
  const now = opts.now ?? new Date();
  const store = proactiveStore();
  const cfg = store.brief();
  // W2b: pull fresh mail into triage first (best effort; Gmail not connected → skipped).
  try {
    const { gmailFor, syncGmail } = await import("@/server/connectors.server");
    if (gmailFor()) await syncGmail();
  } catch (error) {
    console.warn(`[sable-brief] gmail sync skipped: ${error instanceof Error ? error.message.slice(0, 160) : "error"}`);
  }
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
  const needing = (await tasksInbox()).tasks.filter((t) => t.state === "waiting_approval" || t.bucket === "needs_reply").slice(0, 12);
  const record: BriefRecord = { id, at: now.getTime(), title: brief.title, text: brief.text, manual: opts.manual, delivered, counts: brief.counts, items: needing };
  store.addBrief(record);
  store.setBrief({ lastRunAt: now.getTime(), ...(opts.slot ? { lastSlot: opts.slot } : {}) });
  audit({
    type: "brief.delivered",
    initiator: opts.manual ? { kind: "user", id: "owner:web" } : { kind: "routine", id: BRIEF_ROUTINE_ID },
    summary: `${brief.title} → ${delivered.join(" + ")}`,
    ok: true,
  });
  return { ok: true as const, brief: record };
}


export function briefView() {
  const cfg = proactiveStore().brief();
  return { enabled: briefOn(), config: cfg, routineId: BRIEF_ROUTINE_ID, history: proactiveStore().briefs().slice(0, 10) };
}

export function updateBrief(patch: Partial<BriefConfig>) {
  const { enabled, time, tz, telegram } = patch;
  const out = proactiveStore().setBrief({ enabled, time, tz, telegram });
  try {
    syncBriefRoutine();
  } catch (error) {
    console.warn(`[sable-brief] routine sync failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return out;
}

/** W2c: the brief is a real routine (builtin) — schedule "MM HH * * *" in cfg.tz. */
export function briefRoutineDef(cfg: BriefConfig = proactiveStore().brief(), on = briefOn()) {
  const [h, m] = cfg.time.split(":").map((n) => Number(n));
  return {
    id: BRIEF_ROUTINE_ID,
    builtin: "morning-brief",
    name: "Bản tin buổi sáng",
    prompt: "(tích hợp) Soạn bản tin sáng: triage, việc cần duyệt, lịch hôm nay, ngân sách. Không gửi gì ra ngoài ngoài Telegram của chủ (nếu bật).",
    schedule: { kind: "cron" as const, expr: `${m} ${h} * * *` },
    tz: cfg.tz,
    enabled: on && cfg.enabled,
    catchUp: true,
  };
}

/** Create/re-sync the brief routine from the brief settings (boot + every settings change). */
export function syncBriefRoutine() {
  const { scheduler, foreignOwner } = jobService();
  if (foreignOwner !== null) return null;
  return scheduler.upsertBriefSafe(briefRoutineDef());
}

/** Max lateness of a (catch-up) brief: a stale brief late at night is skipped. */
export const BRIEF_MAX_LATE_MS = 3 * 3_600_000;

/** Builtin handler called by the routine scheduler. Returns a history note. */
export function fireBriefRoutine(scheduledFor: number, opts: { manual: boolean; now?: number }): string {
  if (!briefOn()) return "Bản tin tắt (SABLE_BRIEF=0) — bỏ qua.";
  const now = opts.now ?? Date.now();
  if (opts.manual) {
    void runBrief({ manual: true }).catch((e) => console.warn(`[sable-brief] failed: ${e instanceof Error ? e.message : String(e)}`));
    return "Chạy tay bản tin.";
  }
  const cfg = proactiveStore().brief();
  const slot = localParts(new Date(scheduledFor), cfg.tz).date;
  if (cfg.lastSlot === slot) return `Đã gửi bản tin ngày ${slot} — bỏ qua.`;
  if (now - scheduledFor > BRIEF_MAX_LATE_MS) {
    proactiveStore().setBrief({ lastSlot: slot });
    return `Trễ quá 3 giờ — bỏ bản tin ngày ${slot}.`;
  }
  // Mark the slot first so a crash mid-run cannot fire twice.
  proactiveStore().setBrief({ lastSlot: slot });
  void runBrief({ manual: false, slot }).catch((e) => console.warn(`[sable-brief] failed: ${e instanceof Error ? e.message : String(e)}`));
  return `Gửi bản tin ngày ${slot}.`;
}

/** @deprecated W2c: replaced by the builtin routine; kept as a boot hook that only syncs it. */
export function startBriefTicker() {
  syncBriefRoutine();
}

// ── Unified Tasks inbox ──────────────────────────────────────────────────────


export async function tasksInbox(opts: { includeSnoozed?: boolean } = {}) {
  const feed = await triageFeed({ includeDone: true });
  const plans = (() => {
    try {
      return plannerBundle().plans.list();
    } catch {
      return [];
    }
  })();
  const jobs = jobService().db.listJobs().slice(0, 100);
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const who = (t: { ref: { jobId?: string; planId?: string; stepId?: string } }) => {
    const job = t.ref.jobId ? byId.get(t.ref.jobId) : undefined;
    if (job) {
      const i = job.initiator ?? initiatorFor(job);
      return { initiator_kind: i.kind, initiator_id: i.id };
    }
    if (t.ref.planId && t.ref.stepId) return { initiator_kind: "agent", initiator_id: `plan:${t.ref.planId}/${t.ref.stepId}` };
    return {};
  };
  const tasks = unify({ plans, triaged: feed.items, jobs, includeSnoozed: opts.includeSnoozed }).map((t) => ({ ...t, ...who(t), chips: assertNoSend(chipsFor(t)) }));
  return { triage: feed.enabled, tasks, counts: stateCounts(tasks), ignored: feed.counts.ignore ?? 0 };
}
