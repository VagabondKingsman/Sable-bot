import type { PlanStep, StepStatus } from "./types.ts";

export type GraphIssue = { ok: false; error: string } | { ok: true };

/** Detect cycles and unknown deps. */
export function validateGraph(steps: PlanStep[]): GraphIssue {
  const ids = new Set(steps.map((s) => s.id));
  if (ids.size !== steps.length) return { ok: false, error: "duplicate step id" };
  for (const step of steps) {
    for (const dep of step.deps) {
      if (!ids.has(dep)) return { ok: false, error: `unknown dep ${dep} on ${step.id}` };
    }
  }
  // Kahn cycle check
  const indeg = new Map<string, number>();
  const outs = new Map<string, string[]>();
  for (const s of steps) {
    indeg.set(s.id, 0);
    outs.set(s.id, []);
  }
  for (const s of steps) {
    for (const d of s.deps) {
      indeg.set(s.id, (indeg.get(s.id) ?? 0) + 1);
      outs.get(d)!.push(s.id);
    }
  }
  const q = [...indeg.entries()].filter(([, n]) => n === 0).map(([id]) => id);
  let seen = 0;
  while (q.length) {
    const id = q.shift()!;
    seen += 1;
    for (const n of outs.get(id) ?? []) {
      const next = (indeg.get(n) ?? 1) - 1;
      indeg.set(n, next);
      if (next === 0) q.push(n);
    }
  }
  if (seen !== steps.length) return { ok: false, error: "cycle in step graph" };
  return { ok: true };
}

const BLOCKED: StepStatus[] = ["pending", "ready", "running", "waiting_approval"];

export function depsSatisfied(step: PlanStep, byId: Map<string, PlanStep>): boolean {
  return step.deps.every((d) => {
    const dep = byId.get(d);
    return dep && (dep.status === "done" || dep.status === "skipped");
  });
}

/** Mark pending→ready when deps done; return newly ready ids. */
export function refreshReady(steps: PlanStep[]): string[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const newly: string[] = [];
  for (const step of steps) {
    if (step.status !== "pending") continue;
    if (depsSatisfied(step, byId)) {
      step.status = "ready";
      newly.push(step.id);
    }
  }
  return newly;
}

export function hasBlocked(steps: PlanStep[]): boolean {
  return steps.some((s) => BLOCKED.includes(s.status));
}
