import fs from "node:fs";
import path from "node:path";
import { validateGraph } from "./graph.ts";
import type { CreatePlanInput, PlanStep, TaskPlan } from "./types.ts";

const DIR = "tasks";

function plannerOn(env: NodeJS.ProcessEnv = process.env) {
  return (env.SABLE_PLANNER ?? "1").trim() !== "0";
}

function newId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function planPath(root: string, id: string) {
  return path.join(root, DIR, `${id}.json`);
}

function writeAtomic(file: string, data: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export class PlanStore {
  private readonly root: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(dataDir: string, env: NodeJS.ProcessEnv = process.env) {
    this.root = dataDir;
    this.env = env;
  }

  enabled() {
    return plannerOn(this.env);
  }

  list(): TaskPlan[] {
    const dir = path.join(this.root, DIR);
    if (!fs.existsSync(dir)) return [];
    const out: TaskPlan[] = [];
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const plan = this.get(name.slice(0, -5));
      if (plan) out.push(plan);
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): TaskPlan | null {
    try {
      const raw = JSON.parse(fs.readFileSync(planPath(this.root, id), "utf8")) as TaskPlan;
      if (!raw?.id || !Array.isArray(raw.steps)) return null;
      return raw;
    } catch {
      return null;
    }
  }

  save(plan: TaskPlan) {
    writeAtomic(planPath(this.root, plan.id), JSON.stringify(plan, null, 2));
  }

  create(input: CreatePlanInput): { ok: true; plan: TaskPlan } | { ok: false; error: string } {
    if (!this.enabled()) return { ok: false, error: "SABLE_PLANNER=0" };
    const now = input.now ?? Date.now();
    const id = newId("plan");
    const steps: PlanStep[] = input.steps.map((s, i) => ({
      id: s.id?.trim() || `s${i + 1}`,
      title: s.title.trim().slice(0, 200) || `Step ${i + 1}`,
      kind: s.kind ?? "note",
      deps: [...(s.deps ?? [])],
      status: "pending",
      difficulty: s.difficulty,
      requiresApproval: s.requiresApproval ?? (s.kind === "write_gate" || s.kind === "agent"),
    }));
    const graph = validateGraph(steps);
    if (!graph.ok) return { ok: false, error: graph.error };
    const maxSteps = Math.min(50, Math.max(1, input.maxSteps ?? steps.length + 5));
    if (steps.length > maxSteps) return { ok: false, error: `too many steps (max ${maxSteps})` };
    const plan: TaskPlan = {
      id,
      goal: input.goal.trim().slice(0, 4_000) || "untitled",
      status: "draft",
      steps,
      workspaceId: (input.workspaceId ?? id).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80) || id,
      createdAt: now,
      updatedAt: now,
      maxSteps,
      timeoutMs: Math.min(6 * 3_600_000, Math.max(60_000, input.timeoutMs ?? 30 * 60_000)),
      budgetTokens: input.budgetTokens,
      budgetUsd: input.budgetUsd,
      usedTokens: 0,
      usedUsd: 0,
      checkpoint: { lastTickAt: now, completedStepIds: [] },
    };
    this.save(plan);
    return { ok: true, plan };
  }

  delete(id: string): boolean {
    const file = planPath(this.root, id);
    try {
      fs.unlinkSync(file);
      return true;
    } catch {
      return false;
    }
  }
}
