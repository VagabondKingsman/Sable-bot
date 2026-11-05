/**
 * Background jobs, routines and the in-app inbox. Shared by the server runner
 * (persisted as JSON) and the UI (fetched from /api/jobs, /api/routines, /api/inbox).
 */
import type { ApprovalRequest, ChatRequest, TraceStep } from "../types.ts";

export type JobStatus = "queued" | "running" | "waiting_approval" | "done" | "failed" | "cancelled";

export const ACTIVE_STATUSES: readonly JobStatus[] = ["queued", "running", "waiting_approval"];
export const FINAL_STATUSES: readonly JobStatus[] = ["done", "failed", "cancelled"];

export function isActive(status: JobStatus) {
  return ACTIVE_STATUSES.includes(status);
}

export type JobOrigin = { channel: "telegram"; chatId: number } | { channel: "webhook"; peerId: string };

export type JobApproval = ApprovalRequest & { expiresAt?: number };

export type Job = {
  id: string;
  title: string;
  kind: "agent" | "routine";
  routineId?: string;
  /** Routine slot this run belongs to (epoch ms). */
  scheduledFor?: number;
  catchUp?: boolean;
  status: JobStatus;
  request: ChatRequest;
  maxSteps: number;
  /** Wall-clock budget while running; time spent waiting for approval does not count. */
  timeoutMs: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** Ms spent running (excluding approval waits). */
  usedMs: number;
  attempts: number;
  text: string;
  steps: TraceStep[];
  approvals: JobApproval[];
  notices: string[];
  citations: string[];
  statusText?: string;
  error?: string;
  stopped?: "max_steps";
  cancelRequested?: boolean;
  /** Run-now of a routine (not a schedule slot). */
  manual?: boolean;
  /** Where the request came from when not the web UI (replies go back there, owner only). */
  origin?: JobOrigin;
  /** W2a: who started this run (user | routine | trigger | agent | subagent | channel). */
  initiator?: import("../audit/types.ts").Initiator;
  /** false between the final save and the inbox write; recovery redelivers it. */
  delivered?: boolean;
  /** Set when a routine run replied NO_CHANGE (no inbox item, no channel ping). */
  skippedReason?: "unchanged";
  /** Planner task / isolated workspace (W1). */
  taskId?: string;
  workspaceId?: string;
  /** Owner-approved ScopeGate id for ACT tools. */
  scopeId?: string;
};

/** List view: everything but the heavy fields. */
export type JobSummary = Omit<Job, "request" | "text" | "steps" | "citations"> & {
  model: string;
  prompt: string;
  snippet: string;
  stepCount: number;
};

export type Schedule = { kind: "cron"; expr: string } | { kind: "interval"; minutes: number };

export type RoutineRun = {
  id: string;
  at: number;
  scheduledFor: number;
  outcome: "queued" | "missed" | "busy" | "error" | "manual" | "webhook" | "watch" | "builtin";
  catchUp?: boolean;
  jobId?: string;
  note?: string;
};

export type Routine = {
  id: string;
  name: string;
  prompt: string;
  schedule: Schedule;
  tz: string;
  enabled: boolean;
  /** Run one catch-up when a slot was missed (box asleep / server down). */
  catchUp: boolean;
  model: string;
  effort: ChatRequest["effort"];
  presetName?: string;
  instructions: string;
  memory: string;
  tools: ChatRequest["tools"];
  maxSteps: number;
  createdAt: number;
  updatedAt: number;
  /** Interval slots are anchor + k·interval; reset when the timing changes. */
  anchorAt: number;
  nextRunAt: number | null;
  lastRunAt?: number;
  history: RoutineRun[];
  /** Event triggers (webhook / URL watch), in addition to the schedule. */
  trigger?: import("./triggers.ts").RoutineTrigger;
  /** W2c: a built-in routine (no LLM job): the scheduler calls the named handler instead. */
  builtin?: string;
};

export type InboxItem = {
  id: string;
  kind: "result" | "approval" | "brief";
  /** "" for items that belong to no job (the morning brief). */
  jobId: string;
  /** approval items: which ask this is, so its decision can settle it */
  approvalId?: string;
  routineId?: string;
  title: string;
  status: JobStatus;
  snippet: string;
  createdAt: number;
  read: boolean;
};

export function summarize(job: Job): JobSummary {
  const { request, text, steps, citations: _citations, ...rest } = job;
  const last = [...request.messages].reverse().find((message) => message.role === "user");
  return {
    ...rest,
    model: request.model,
    prompt: (last?.content ?? "").slice(0, 300),
    snippet: text.replace(/\s+/g, " ").trim().slice(0, 240),
    stepCount: steps.length,
  };
}
