/**
 * W2a audit + decider policy, server side. All approval decisions — web UI
 * (/api/tools, /api/tasks approve_step), Telegram buttons, webhook
 * approval.response — go through `decideAs`, which checks `canDecide` and
 * writes an audit record either way. Background initiators can never decide.
 */
import { AuditLog } from "@/lib/agent/audit/log";
import { canDecide } from "@/lib/agent/audit/policy";
import type { AuditRecord, AuditType, Initiator, InitiatorKind } from "@/lib/agent/audit/types";
import type { ClientEvent } from "@/lib/agent/harness";
import type { ToolContext } from "@/lib/agent/tools/types";
import { sharedApprovals } from "@/lib/agent/tools/approvals";
import { dataDir } from "@/server/paths";
import { jobService } from "@/server/jobs.server";
import { scopeStore } from "@/server/scope.server";

const KEY = Symbol.for("sable.audit.v1");
type State = { log: AuditLog; chatAsks: Map<string, { initiator: Initiator; at: number }> };
type G = typeof globalThis & { [KEY]?: State };

function state(): State {
  const g = globalThis as G;
  return (g[KEY] ??= { log: new AuditLog(dataDir()), chatAsks: new Map() });
}

export function auditLog() {
  return state().log;
}

export function audit(input: Parameters<AuditLog["record"]>[0]): AuditRecord | null {
  try {
    return state().log.record(input);
  } catch (error) {
    console.warn(`[sable-audit] write failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/** ToolContext.audit for a run: records each side-effecting call. */
export function auditSink(jobId?: string): NonNullable<ToolContext["audit"]> {
  return (e) => {
    audit({ type: "side_effect", initiator: e.initiator, tool: e.tool, risk: e.risk, summary: e.summary, ok: e.ok, jobId, traceRef: e.stepId, reason: e.reason });
  };
}

/**
 * Wrap a chat turn's emit so each approval card it shows is registered with
 * its initiator (for the decide policy) and audited as requested.
 */
export function auditingEmit(emit: (event: ClientEvent) => void, initiator: Initiator) {
  return (event: ClientEvent) => {
    if (event.event === "approval" && event.data.state === "pending") {
      const asks = state().chatAsks;
      asks.set(event.data.id, { initiator, at: Date.now() });
      if (asks.size > 500) for (const [k] of [...asks].slice(0, 100)) asks.delete(k);
      audit({ type: "approval.requested", initiator, tool: event.data.tool, summary: event.data.summary, approvalId: event.data.id });
    }
    emit(event);
  };
}

/** Background job asked for approval (called from jobs.server onWaiting). */
export function auditJobAsk(job: { id: string; initiator?: Initiator }, approval: { id: string; tool: string; summary: string }) {
  audit({ type: "approval.requested", initiator: job.initiator ?? { kind: "user", id: "owner:web" }, tool: approval.tool, summary: approval.summary, approvalId: approval.id, jobId: job.id });
}

function askOwner(approvalId: string): { initiator: Initiator | null; jobId?: string; tool?: string } {
  const chat = state().chatAsks.get(approvalId);
  if (chat) return { initiator: chat.initiator };
  const job = jobService()
    .db.listJobs()
    .find((j) => j.approvals.some((a) => a.id === approvalId));
  if (job) return { initiator: job.initiator ?? null, jobId: job.id, tool: job.approvals.find((a) => a.id === approvalId)?.tool };
  return { initiator: null };
}

export type DecideOutcome = { ok: true } | { ok: false; status: 403 | 404; reason: string };

/** The one way to decide an approval. */
export function decideAs(
  approvalId: string,
  approve: boolean,
  decider: Initiator,
  /** jobsOnly: outside channels may only answer background-job asks (as before W2a). */
  opts: { scope?: boolean; jobsOnly?: boolean } = {},
): DecideOutcome {
  const owner = askOwner(approvalId);
  const policy = canDecide(decider, owner.initiator);
  const base = { approvalId, jobId: owner.jobId, tool: owner.tool, approve, decider, initiator: owner.initiator ?? decider };
  if (!policy.ok) {
    audit({ type: "approval.denied_policy", ...base, reason: policy.reason, ok: false });
    return { ok: false, status: 403, reason: policy.reason };
  }
  const found = opts.jobsOnly
    ? jobService().runner.decide(approvalId, approve)
    : sharedApprovals().decide(approvalId, approve) ||
      jobService().runner.decide(approvalId, approve) ||
      Boolean(opts.scope || approvalId.startsWith("scope_") ? scopeStore().decide(approvalId, approve ? "approved" : "denied", approvalId) : null);
  if (!found) return { ok: false, status: 404, reason: "not pending" };
  state().chatAsks.delete(approvalId);
  audit({ type: "approval.decided", ...base, ok: true });
  return { ok: true };
}

/** Planner step approvals (asked by the planner = agent), same policy. */
export function decideStepAs(planId: string, stepId: string, approve: boolean, decider: Initiator, run: () => { ok: boolean; error?: string }): DecideOutcome {
  const initiator: Initiator = { kind: "agent", id: `plan:${planId}/${stepId}` };
  const policy = canDecide(decider, initiator);
  if (!policy.ok) {
    audit({ type: "approval.denied_policy", initiator, decider, approve, approvalId: `step:${planId}:${stepId}`, reason: policy.reason, ok: false });
    return { ok: false, status: 403, reason: policy.reason };
  }
  const res = run();
  if (!res.ok) return { ok: false, status: 404, reason: res.error ?? "step not waiting" };
  audit({ type: "approval.decided", initiator, decider, approve, approvalId: `step:${planId}:${stepId}`, ok: true });
  return { ok: true };
}

export function listAudit(q: { type?: AuditType; kind?: InitiatorKind; jobId?: string; approvalId?: string; since?: number; limit?: number }) {
  return state().log.list(q);
}
