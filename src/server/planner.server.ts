import { BudgetMeter } from "@/lib/agent/budget/meter";
import { PlanExecutor } from "@/lib/agent/planner/executor";
import { PlanStore } from "@/lib/agent/planner/store";
import { WorkspaceStore } from "@/lib/agent/workspace/store";
import { dataDir, workspaceDir } from "@/server/paths";

const KEY = Symbol.for("sable.planner.v1");

type Bundle = {
  plans: PlanStore;
  executor: PlanExecutor;
  workspaces: WorkspaceStore;
  budget: BudgetMeter;
};

export function plannerBundle(): Bundle {
  const scope = globalThis as unknown as Record<symbol, Bundle | undefined>;
  if (!scope[KEY]) {
    const plans = new PlanStore(dataDir());
    const workspaces = new WorkspaceStore(workspaceDir());
    const budget = new BudgetMeter(dataDir());
    const executor = new PlanExecutor(plans, {
      checkBudget: (plan, step) => {
        const add = step.difficulty === "hard" ? 800 : 80;
        return budget.checkPlan(plan, add);
      },
      recordUsage: (plan, step, tokens) => {
        const model = step.difficulty === "light" ? (process.env.SABLE_MODEL_LIGHT || "gpt-4.1-mini") : (process.env.SABLE_MODEL_HARD || "grok-4.7");
        const ev = budget.record({
          scope: "plan",
          scopeId: plan.id,
          model,
          promptTokens: Math.floor(tokens * 0.7),
          completionTokens: Math.ceil(tokens * 0.3),
        });
        plan.usedTokens += ev.totalTokens;
        plan.usedUsd += ev.usd;
      },
    });
    scope[KEY] = { plans, executor, workspaces, budget };
  }
  return scope[KEY]!;
}
