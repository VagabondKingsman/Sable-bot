/**
 * W2a initiator_kind audit. Every side-effecting tool call and every approval
 * record says who started the chain that led to it, and who decided it.
 *   user      — the owner in the web UI (chat turn, UI-created job, manual run-now)
 *   routine   — a scheduled routine run (id = routine id) or the built-in brief
 *   trigger   — an event-fired routine run (webhook / watch trigger)
 *   agent     — a planner task step (id = plan:step)
 *   subagent  — a spawn_agent child (id = parent step id)
 *   channel   — an outside channel message (id = telegram:<chat> | webhook:<peer>)
 */
export const INITIATOR_KINDS = ["user", "routine", "trigger", "agent", "subagent", "channel"] as const;
export type InitiatorKind = (typeof INITIATOR_KINDS)[number];
export type Initiator = { kind: InitiatorKind; id: string; /** chain parent, e.g. a subagent's run initiator */ via?: Initiator };

/** Initiators with nobody watching: they may request approvals, never grant them. */
export const BACKGROUND_KINDS: readonly InitiatorKind[] = ["routine", "trigger", "agent", "subagent"];

export type AuditType =
  | "side_effect"
  | "approval.requested"
  | "approval.decided"
  | "approval.denied_policy"
  | "brief.delivered";

export type AuditRecord = {
  id: string;
  at: number;
  type: AuditType;
  initiator_kind: InitiatorKind;
  initiator_id: string;
  /** Root of the chain when the direct initiator is a subagent. */
  via_kind?: InitiatorKind;
  via_id?: string;
  tool?: string;
  summary?: string;
  risk?: string;
  ok?: boolean;
  approvalId?: string;
  jobId?: string;
  traceRef?: string;
  decider_kind?: InitiatorKind;
  decider_id?: string;
  approve?: boolean;
  reason?: string;
};

export function isInitiatorKind(v: unknown): v is InitiatorKind {
  return typeof v === "string" && (INITIATOR_KINDS as readonly string[]).includes(v);
}

export const USER: Initiator = { kind: "user", id: "owner:web" };
