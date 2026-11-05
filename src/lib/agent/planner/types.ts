/** Long-horizon task graph (planner / executor). */

export type PlanStatus = "draft" | "running" | "paused" | "waiting_approval" | "done" | "failed" | "cancelled";

export type StepStatus = "pending" | "ready" | "running" | "waiting_approval" | "done" | "failed" | "skipped" | "cancelled";

/** Benign step kinds only — no RE/pentest/CTF. */
export type StepKind = "note" | "classify" | "agent" | "write_gate" | "doc_audit";

export type PlanStep = {
  id: string;
  title: string;
  kind: StepKind;
  /** Step ids that must be done first. */
  deps: string[];
  status: StepStatus;
  /** Optional model hint for budget router. */
  difficulty?: "light" | "hard";
  /** Side-effecting steps always need owner approval before ACT. */
  requiresApproval: boolean;
  /** Checkpoint blob (JSON-serializable). */
  checkpoint?: Record<string, unknown>;
  result?: string;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
  approvalId?: string;
  /** Job id when this step was handed to JobRunner. */
  jobId?: string;
};

export type TaskPlan = {
  id: string;
  goal: string;
  status: PlanStatus;
  steps: PlanStep[];
  /** Isolated workspace id (usually same as plan id). */
  workspaceId: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** Index of current focus step (for UI). */
  currentStepId?: string;
  maxSteps: number;
  timeoutMs: number;
  /** Soft budget for this plan (optional). */
  budgetTokens?: number;
  budgetUsd?: number;
  usedTokens: number;
  usedUsd: number;
  error?: string;
  /** Crash/resume marker. */
  checkpoint?: { lastTickAt: number; completedStepIds: string[] };
  /** W2c: who created the plan (owner via web/API; agent/routine if ever wired). */
  initiator?: { kind: string; id: string };
};

export type CreatePlanInput = {
  goal: string;
  steps: Array<{
    id?: string;
    title: string;
    kind?: StepKind;
    deps?: string[];
    difficulty?: "light" | "hard";
    requiresApproval?: boolean;
  }>;
  maxSteps?: number;
  timeoutMs?: number;
  budgetTokens?: number;
  budgetUsd?: number;
  workspaceId?: string;
  now?: number;
  initiator?: { kind: string; id: string };
};
