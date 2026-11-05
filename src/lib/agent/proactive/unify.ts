/**
 * One Tasks inbox: planner tasks + approval asks + triaged items + active
 * background jobs, each in one of four states. Pure; the server feeds it.
 */
import type { TriagedItem } from "./feed.ts";
import type { TriageBucket, TriageUrgency } from "./triage.ts";

export type TaskState = "todo" | "doing" | "waiting_approval" | "done";
export const TASK_STATES: readonly TaskState[] = ["waiting_approval", "todo", "doing", "done"];

export type UnifiedKind = "plan" | "approval" | "triage" | "job";

export type UnifiedTask = {
  id: string;
  kind: UnifiedKind;
  title: string;
  detail: string;
  state: TaskState;
  at: number;
  bucket?: TriageBucket;
  urgency?: TriageUrgency;
  reason?: string;
  decidedBy?: string;
  snoozed?: boolean;
  chips?: import("./chips.ts").Chip[];
  ref: { planId?: string; stepId?: string; approvalId?: string; jobId?: string; inboxId?: string; triageId?: string; routineId?: string };
};

export type PlanLike = {
  id: string;
  goal: string;
  status: string;
  updatedAt: number;
  steps: { id: string; title: string; status: string; approvalId?: string }[];
};
export type JobLike = { id: string; title: string; status: string; createdAt: number; routineId?: string };

export function planState(status: string): TaskState {
  if (status === "running") return "doing";
  if (status === "waiting_approval") return "waiting_approval";
  if (status === "done" || status === "failed" || status === "cancelled") return "done";
  return "todo"; // draft, paused
}

export function unify(input: { plans: PlanLike[]; triaged: TriagedItem[]; jobs: JobLike[]; includeSnoozed?: boolean }): UnifiedTask[] {
  const out: UnifiedTask[] = [];
  for (const p of input.plans) {
    const done = p.steps.filter((s) => s.status === "done" || s.status === "skipped").length;
    out.push({ id: `plan:${p.id}`, kind: "plan", title: p.goal, detail: `${done}/${p.steps.length} bước · ${p.status}`, state: planState(p.status), at: p.updatedAt, ref: { planId: p.id } });
    for (const s of p.steps)
      if (s.status === "waiting_approval")
        out.push({ id: `step:${p.id}:${s.id}`, kind: "approval", title: `${p.goal} → ${s.title}`, detail: "Bước kế hoạch chờ duyệt", state: "waiting_approval", at: p.updatedAt, ref: { planId: p.id, stepId: s.id, approvalId: s.approvalId } });
  }
  const jobsWithAsk = new Set<string>();
  for (const it of input.triaged) {
    if (it.result.bucket === "ignore") continue;
    if (it.snoozed && !input.includeSnoozed) continue;
    const meta = it.input.meta ?? {};
    const approval = it.result.bucket === "needs_approval";
    if (approval && meta.jobId) jobsWithAsk.add(meta.jobId);
    const fromInbox = it.input.source === "inbox" || it.input.source === "routine";
    out.push({
      id: `triage:${it.input.id}`,
      kind: approval ? "approval" : "triage",
      title: it.input.title,
      detail: it.input.body.slice(0, 240),
      state: it.state?.done ? "done" : approval ? "waiting_approval" : "todo",
      at: it.input.at,
      bucket: it.result.bucket,
      urgency: it.result.urgency,
      reason: it.result.reason,
      decidedBy: it.result.decidedBy,
      snoozed: it.snoozed,
      ref: { triageId: it.input.id, approvalId: meta.approvalId, jobId: meta.jobId, inboxId: fromInbox ? it.input.id : undefined, routineId: meta.routineId },
    });
  }
  for (const j of input.jobs) {
    if (j.status !== "running" && j.status !== "queued") continue;
    if (jobsWithAsk.has(j.id)) continue;
    out.push({ id: `job:${j.id}`, kind: "job", title: j.title, detail: j.status === "queued" ? "Đang chờ chạy" : "Đang chạy", state: "doing", at: j.createdAt, ref: { jobId: j.id, routineId: j.routineId } });
  }
  const rank = (t: UnifiedTask) => TASK_STATES.indexOf(t.state) * 10 + (t.urgency === "high" ? 0 : t.urgency === "low" ? 2 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || b.at - a.at);
}

export function stateCounts(tasks: UnifiedTask[]) {
  const c: Record<TaskState, number> = { todo: 0, doing: 0, waiting_approval: 0, done: 0 };
  for (const t of tasks) c[t.state]++;
  return c;
}
