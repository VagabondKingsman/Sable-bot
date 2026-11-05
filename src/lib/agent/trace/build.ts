/**
 * Pure converters from Sable's existing step records (job.steps, chat
 * message.steps, plan.steps) to one Trace shape. No I/O. Details are clipped
 * and passed through the secret redactor before they leave the server.
 */
import type { ApprovalRequest, ChatMessage, TraceStep } from "../types.ts";
import type { Job } from "../jobs/types.ts";
import type { TaskPlan } from "../planner/types.ts";
import { redactSecrets } from "../memory/redact.ts";
import { TRACE_SCHEMA, type Trace, type TraceEvent, type TraceExport, type TraceStats, type TraceSummary } from "./types.ts";

export const MAX_DETAIL = 2_000;
export const MAX_EVENTS = 400;
const ID_PART = /^[A-Za-z0-9_-]{1,120}$/;

function clipDetail(text: string | undefined) {
  if (!text) return undefined;
  return redactSecrets(text.slice(0, MAX_DETAIL)).text;
}

/** "ok · 123 ms" first line written by loop.ts (pre-W2 records have no ms field). */
export function msFromDetail(detail: string | undefined): number | undefined {
  const m = detail?.match(/^(ok|lỗi) · (\d+) ms/);
  return m ? Number(m[2]) : undefined;
}

function okFromDetail(detail: string | undefined): boolean | undefined {
  if (!detail) return undefined;
  if (detail.startsWith("ok ·")) return true;
  if (detail.startsWith("lỗi ·")) return false;
  return undefined;
}

export function stepEvent(step: TraceStep): TraceEvent {
  const type: TraceEvent["type"] =
    step.tool === "spawn_agent"
      ? "subagent"
      : step.kind === "web" || step.kind === "x"
        ? "search"
        : step.kind === "think"
          ? "think"
          : "tool";
  const ev: TraceEvent = {
    id: step.id,
    type,
    label: redactSecrets(step.label.slice(0, 400)).text,
    state: step.state ?? "done",
  };
  const tool = step.tool ?? (step.kind !== "tool" ? step.kind : undefined);
  if (tool) ev.tool = tool;
  if (step.at != null) ev.at = step.at;
  const ms = step.ms ?? msFromDetail(step.detail);
  if (ms != null) ev.ms = ms;
  if (step.parent) ev.parent = step.parent;
  const detail = clipDetail(step.detail);
  if (detail) ev.detail = detail;
  const ok = okFromDetail(step.detail);
  if (ok != null) ev.ok = ok;
  return ev;
}

function approvalEvent(a: ApprovalRequest & { expiresAt?: number }): TraceEvent {
  return {
    id: `approval-${a.id}`,
    type: "approval",
    label: redactSecrets(`${a.tool}: ${a.summary}`.slice(0, 400)).text,
    tool: a.tool,
    state: a.state,
    ok: a.state === "approved" ? true : a.state === "rejected" ? false : undefined,
  };
}

export function computeStats(events: TraceEvent[]): TraceStats {
  const tools: Record<string, number> = {};
  let toolCalls = 0;
  let approvals = 0;
  let approvalsPending = 0;
  let subAgents = 0;
  let errors = 0;
  let toolMs = 0;
  for (const ev of events) {
    if (ev.type === "tool" || ev.type === "subagent" || ev.type === "search") {
      toolCalls += 1;
      if (ev.tool) tools[ev.tool] = (tools[ev.tool] ?? 0) + 1;
      if (ev.ms != null && !ev.parent) toolMs += ev.ms;
    }
    if (ev.type === "subagent") subAgents += 1;
    if (ev.type === "approval") {
      approvals += 1;
      if (ev.state === "pending") approvalsPending += 1;
    }
    if (ev.ok === false || ev.state === "failed") errors += 1;
  }
  return { events: events.length, toolCalls, approvals, approvalsPending, subAgents, errors, tools, toolMs };
}

function finish(base: Omit<Trace, "events" | "stats" | "durationMs">, events: TraceEvent[]): Trace {
  const kept = events.slice(0, MAX_EVENTS);
  const durationMs = base.startedAt && base.finishedAt ? Math.max(0, base.finishedAt - base.startedAt) : undefined;
  return { ...base, ...(durationMs != null ? { durationMs } : {}), events: kept, stats: computeStats(kept) };
}

function jobInitiator(job: Job): { initiator_kind: string; initiator_id: string } {
  const i =
    job.initiator ??
    (job.origin?.channel === "telegram"
      ? { kind: "channel", id: `telegram:${job.origin.chatId}` }
      : job.origin?.channel === "webhook"
        ? { kind: "channel", id: `webhook:${job.origin.peerId}` }
        : job.routineId && !job.manual
          ? { kind: "routine", id: job.routineId }
          : { kind: "user", id: "owner:web" });
  return { initiator_kind: i.kind, initiator_id: i.id };
}

export function fromJob(job: Job): Trace {
  const events = job.steps.map(stepEvent);
  for (const a of job.approvals) events.push(approvalEvent(a));
  if (job.error) events.push({ id: "error", type: "notice", label: redactSecrets(job.error.slice(0, 400)).text, state: "failed", ok: false });
  for (const [i, n] of job.notices.entries()) events.push({ id: `notice-${i}`, type: "notice", label: redactSecrets(n.slice(0, 400)).text, state: "done" });
  return finish(
    {
      id: `job.${job.id}`,
      source: "job",
      sourceId: job.id,
      title: job.title.slice(0, 200),
      status: job.status,
      model: job.request?.model,
      ...jobInitiator(job),
      startedAt: job.startedAt ?? job.createdAt,
      finishedAt: job.finishedAt,
      updatedAt: job.updatedAt,
    },
    events,
  );
}

export function fromPlan(plan: TaskPlan): Trace {
  const events: TraceEvent[] = plan.steps.map((s) => {
    const ev: TraceEvent = {
      id: `step-${s.id}`,
      type: "plan_step",
      label: redactSecrets(`${s.title} (${s.kind})`.slice(0, 400)).text,
      tool: `plan:${s.kind}`,
      state: s.status,
      actor: s.kind === "agent" ? "agent" : "system",
    };
    if (s.startedAt) ev.at = s.startedAt;
    if (s.startedAt && s.finishedAt) ev.ms = Math.max(0, s.finishedAt - s.startedAt);
    const detail = clipDetail(s.error ?? s.result);
    if (detail) ev.detail = detail;
    if (s.status === "done") ev.ok = true;
    if (s.status === "failed") ev.ok = false;
    return ev;
  });
  for (const s of plan.steps) {
    if (s.requiresApproval && (s.status === "waiting_approval" || s.result === "approved" || s.status === "failed")) {
      events.push({
        id: `approval-${s.id}`,
        type: "approval",
        label: redactSecrets(`write_gate: ${s.title}`.slice(0, 400)).text,
        tool: `plan:${s.kind}`,
        state: s.status === "waiting_approval" ? "pending" : s.result === "approved" ? "approved" : "rejected",
        actor: "user",
      });
    }
  }
  return finish(
    {
      id: `plan.${plan.id}`,
      source: "plan",
      sourceId: plan.id,
      title: plan.goal.slice(0, 200),
      status: plan.status,
      // W2c: the real initiator (plans are created by the owner; legacy plans had none → owner).
      initiator_kind: plan.initiator?.kind ?? "user",
      initiator_id: plan.initiator?.id ?? "owner:web",
      startedAt: plan.startedAt ?? plan.createdAt,
      finishedAt: plan.finishedAt,
      updatedAt: plan.updatedAt,
    },
    events,
  );
}

/** One assistant message of a chat thread = one trace (only when it ran steps or asked for approval). */
export function fromChat(threadId: string, title: string, message: ChatMessage, mtime: number): Trace | null {
  if (message.role !== "assistant") return null;
  const steps = message.steps ?? [];
  const approvals = message.approvals ?? [];
  if (!steps.length && !approvals.length) return null;
  const events = steps.map(stepEvent);
  for (const a of approvals) events.push(approvalEvent(a));
  return finish(
    {
      id: `chat.${threadId}.${message.id}`,
      source: "chat",
      sourceId: `${threadId}/${message.id}`,
      title: (title || "chat").slice(0, 200),
      status: message.finishedAt ? "done" : "running",
      initiator_kind: "user",
      initiator_id: "owner:web",
      startedAt: message.startedAt,
      finishedAt: message.finishedAt,
      updatedAt: message.finishedAt ?? mtime,
    },
    events,
  );
}

export function isFinal(trace: Trace) {
  return ["done", "failed", "cancelled"].includes(trace.status) && Boolean(trace.finishedAt);
}

export function summarize(trace: Trace): TraceSummary {
  const { events: _events, ...rest } = trace;
  return rest;
}

/** Keep only events of one tool (plus their sub-agent children and related approvals). */
export function filterByTool(trace: Trace, tool: string): Trace {
  const keep = new Set(trace.events.filter((e) => e.tool === tool).map((e) => e.id));
  const events = trace.events.filter((e) => keep.has(e.id) || (e.parent && keep.has(e.parent)));
  return { ...trace, events, stats: computeStats(events) };
}

export function exportTrace(trace: Trace, now = Date.now()): TraceExport {
  return { schema: TRACE_SCHEMA, exportedAt: now, trace };
}

export function validTraceId(id: string) {
  const parts = id.split(".");
  if (parts.length < 2 || parts.length > 3) return false;
  const [source, ...rest] = parts;
  if (source !== "job" && source !== "plan" && source !== "chat") return false;
  if (source === "chat" ? rest.length !== 2 : rest.length !== 1) return false;
  return rest.every((p) => ID_PART.test(p));
}

export function isTraceExport(value: unknown): value is TraceExport {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const t = v.trace as Record<string, unknown> | undefined;
  return (
    v.schema === TRACE_SCHEMA &&
    typeof v.exportedAt === "number" &&
    !!t &&
    typeof t.id === "string" &&
    typeof t.source === "string" &&
    Array.isArray(t.events) &&
    !!t.stats &&
    typeof t.stats === "object"
  );
}
