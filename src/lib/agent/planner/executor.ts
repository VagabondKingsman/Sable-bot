/**
 * Plan executor: advances ready steps, checkpoints after each, pause/resume.
 * Side-effect steps never auto-approve — they enter waiting_approval.
 */
import { hasBlocked, refreshReady } from "./graph.ts";
import type { PlanStore } from "./store.ts";
import type { PlanStep, PlanStatus, TaskPlan } from "./types.ts";

export type ExecutorHooks = {
  /** Optional: run an agent step (enqueue job). Return job id or error. */
  runAgentStep?: (plan: TaskPlan, step: PlanStep) => Promise<{ ok: true; jobId?: string; result?: string } | { ok: false; error: string }>;
  /** Budget check before a step. */
  checkBudget?: (plan: TaskPlan, step: PlanStep) => { ok: true } | { ok: false; error: string };
  /** Record light token use for classify/note (synthetic). */
  recordUsage?: (plan: TaskPlan, step: PlanStep, tokens: number) => void;
  now?: () => number;
};

function plannerOn(env: NodeJS.ProcessEnv = process.env) {
  return (env.SABLE_PLANNER ?? "1").trim() !== "0";
}

export class PlanExecutor {
  private readonly store: PlanStore;
  private readonly hooks: ExecutorHooks;
  private readonly env: NodeJS.ProcessEnv;

  constructor(store: PlanStore, hooks: ExecutorHooks = {}, env: NodeJS.ProcessEnv = process.env) {
    this.store = store;
    this.hooks = hooks;
    this.env = env;
  }

  start(planId: string): { ok: true; plan: TaskPlan } | { ok: false; error: string } {
    if (!plannerOn(this.env)) return { ok: false, error: "SABLE_PLANNER=0" };
    const plan = this.store.get(planId);
    if (!plan) return { ok: false, error: "plan not found" };
    if (plan.status === "cancelled" || plan.status === "done") return { ok: false, error: `cannot start from ${plan.status}` };
    const now = this.hooks.now?.() ?? Date.now();
    plan.status = "running";
    plan.startedAt ??= now;
    plan.updatedAt = now;
    refreshReady(plan.steps);
    this.store.save(plan);
    return { ok: true, plan };
  }

  pause(planId: string) {
    const plan = this.store.get(planId);
    if (!plan) return { ok: false as const, error: "plan not found" };
    if (plan.status !== "running" && plan.status !== "waiting_approval") {
      return { ok: false as const, error: `cannot pause from ${plan.status}` };
    }
    const now = this.hooks.now?.() ?? Date.now();
    plan.status = "paused";
    plan.updatedAt = now;
    this.checkpoint(plan, now);
    this.store.save(plan);
    return { ok: true as const, plan };
  }

  resume(planId: string) {
    if (!plannerOn(this.env)) return { ok: false as const, error: "SABLE_PLANNER=0" };
    const plan = this.store.get(planId);
    if (!plan) return { ok: false as const, error: "plan not found" };
    if (plan.status !== "paused" && plan.status !== "waiting_approval" && plan.status !== "failed") {
      // Also allow resume after crash: draft with checkpoint or interrupted running→we treat paused/failed
      if (plan.status !== "running" && plan.status !== "draft") {
        return { ok: false as const, error: `cannot resume from ${plan.status}` };
      }
    }
    const now = this.hooks.now?.() ?? Date.now();
    // Reset any mid-flight "running" steps left by a crash back to ready.
    for (const step of plan.steps) {
      if (step.status === "running") {
        step.status = "ready";
        step.error = undefined;
      }
    }
    plan.status = "running";
    plan.error = undefined;
    plan.updatedAt = now;
    refreshReady(plan.steps);
    this.store.save(plan);
    return { ok: true as const, plan };
  }

  cancel(planId: string) {
    const plan = this.store.get(planId);
    if (!plan) return { ok: false as const, error: "plan not found" };
    const now = this.hooks.now?.() ?? Date.now();
    for (const step of plan.steps) {
      if (step.status === "pending" || step.status === "ready" || step.status === "running" || step.status === "waiting_approval") {
        step.status = "cancelled";
        step.finishedAt = now;
      }
    }
    plan.status = "cancelled";
    plan.finishedAt = now;
    plan.updatedAt = now;
    this.store.save(plan);
    return { ok: true as const, plan };
  }

  /** Owner approved a write_gate step (never auto). */
  approveStep(planId: string, stepId: string, approve: boolean) {
    const plan = this.store.get(planId);
    if (!plan) return { ok: false as const, error: "plan not found" };
    const step = plan.steps.find((s) => s.id === stepId);
    if (!step) return { ok: false as const, error: "step not found" };
    if (step.status !== "waiting_approval") return { ok: false as const, error: "step not waiting" };
    const now = this.hooks.now?.() ?? Date.now();
    if (!approve) {
      step.status = "failed";
      step.error = "owner denied";
      step.finishedAt = now;
      plan.status = "failed";
      plan.error = `step ${stepId} denied`;
      plan.finishedAt = now;
      plan.updatedAt = now;
      this.store.save(plan);
      return { ok: true as const, plan };
    }
    step.status = "done";
    step.result = "approved";
    step.finishedAt = now;
    plan.status = "running";
    plan.updatedAt = now;
    this.checkpoint(plan, now);
    this.store.save(plan);
    return { ok: true as const, plan };
  }

  /**
   * Advance until blocked (approval / no ready / done / timeout / max).
   * Safe to call after crash — recovers running→ready then continues.
   */
  async tick(planId: string): Promise<{ ok: true; plan: TaskPlan; advanced: string[] } | { ok: false; error: string }> {
    if (!plannerOn(this.env)) return { ok: false, error: "SABLE_PLANNER=0" };
    const plan = this.store.get(planId);
    if (!plan) return { ok: false, error: "plan not found" };
    if (plan.status === "paused" || plan.status === "cancelled" || plan.status === "done") {
      return { ok: true, plan, advanced: [] };
    }
    const now = this.hooks.now?.() ?? Date.now();
    if (plan.startedAt && now - plan.startedAt > plan.timeoutMs) {
      plan.status = "failed";
      plan.error = "plan timeout";
      plan.finishedAt = now;
      plan.updatedAt = now;
      this.store.save(plan);
      return { ok: false, error: "plan timeout" };
    }
    // Crash recovery
    for (const step of plan.steps) {
      if (step.status === "running") step.status = "ready";
    }
    if (plan.status === "draft" || plan.status === "failed") plan.status = "running";
    plan.startedAt ??= now;

    const advanced: string[] = [];
    let guard = 0;
    while (guard++ < plan.maxSteps) {
      refreshReady(plan.steps);
      const ready = plan.steps.filter((s) => s.status === "ready");
      if (!ready.length) break;
      const step = ready[0]!;
      if (plan.steps.filter((s) => s.status === "done").length >= plan.maxSteps) {
        plan.status = "failed";
        plan.error = "max steps exceeded";
        break;
      }
      const budget = this.hooks.checkBudget?.(plan, step);
      if (budget && !budget.ok) {
        plan.status = "failed";
        plan.error = budget.error;
        plan.finishedAt = now;
        break;
      }
      plan.currentStepId = step.id;
      step.status = "running";
      step.startedAt = now;
      plan.updatedAt = now;
      this.store.save(plan);

      try {
        await this.runStep(plan, step, now);
        advanced.push(step.id);
      } catch (error) {
        step.status = "failed";
        step.error = error instanceof Error ? error.message : String(error);
        step.finishedAt = now;
        plan.status = "failed";
        plan.error = step.error;
        plan.finishedAt = now;
        break;
      }
      this.checkpoint(plan, now);
      this.store.save(plan);
      // runStep mutates statuses; re-read to satisfy control-flow typing
      const stepStatus = plan.steps.find((s) => s.id === step.id)?.status;
      const planStatus = plan.status;
      if (stepStatus === "waiting_approval" || stepStatus === "failed" || planStatus !== "running") break;
    }

    refreshReady(plan.steps);
    if (plan.status === "running" && !hasBlocked(plan.steps)) {
      const allDone = plan.steps.every((s) => s.status === "done" || s.status === "skipped" || s.status === "cancelled");
      if (allDone) {
        plan.status = "done";
        plan.finishedAt = now;
      }
    }
    plan.updatedAt = now;
    this.store.save(plan);
    return { ok: true, plan, advanced };
  }

  private checkpoint(plan: TaskPlan, now: number) {
    plan.checkpoint = {
      lastTickAt: now,
      completedStepIds: plan.steps.filter((s) => s.status === "done" || s.status === "skipped").map((s) => s.id),
    };
  }

  private async runStep(plan: TaskPlan, step: PlanStep, now: number) {
    if (step.requiresApproval && step.kind === "write_gate") {
      step.status = "waiting_approval";
      plan.status = "waiting_approval";
      step.checkpoint = { waitingSince: now };
      return;
    }
    if (step.kind === "agent") {
      if (this.hooks.runAgentStep) {
        const res = await this.hooks.runAgentStep(plan, step);
        if (!res.ok) {
          step.status = "failed";
          step.error = res.error;
          step.finishedAt = now;
          plan.status = "failed";
          plan.error = res.error;
          return;
        }
        step.jobId = res.jobId;
        step.result = res.result ?? "enqueued";
        step.status = "done";
        step.finishedAt = now;
        this.hooks.recordUsage?.(plan, step, 500);
        return;
      }
      // Without a hook: complete as planned note (tests / dry-run) — still no side effects.
      step.result = "agent-dry-run";
      step.status = "done";
      step.finishedAt = now;
      this.hooks.recordUsage?.(plan, step, 200);
      return;
    }
    // note / classify / doc_audit — pure, no approval
    step.result =
      step.kind === "classify"
        ? `classified:${step.title.slice(0, 40)}`
        : step.kind === "doc_audit"
          ? `audited:${step.title.slice(0, 40)}`
          : `noted:${step.title.slice(0, 40)}`;
    step.status = "done";
    step.finishedAt = now;
    step.checkpoint = { result: step.result };
    this.hooks.recordUsage?.(plan, step, step.kind === "classify" ? 50 : 20);
  }
}

export function simulateCrash(plan: TaskPlan): TaskPlan {
  // Leave a step mid-running as if process died.
  const copy: TaskPlan = JSON.parse(JSON.stringify(plan));
  const running = copy.steps.find((s) => s.status === "running");
  if (!running) {
    const ready = copy.steps.find((s) => s.status === "ready" || s.status === "pending");
    if (ready) {
      ready.status = "running";
      copy.status = "running";
    }
  }
  return copy;
}

export type { PlanStatus };
