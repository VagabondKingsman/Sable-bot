/**
 * W4 code task lifecycle (no server imports → unit-testable with a fixture repo + fake LLM).
 * start: worktree under <root>/<id>/wt on branch sable/<id> → agent loop (jail + bwrap) →
 * snapshot diff → owner's test command in the sandbox → status "review".
 * apply (owner only, canDecide "code.apply"): local merge into the repo's current branch.
 * reject: remove worktree + branch. GitHub PR: off (D6).
 */
import type { Initiator } from "../audit/types.ts";
import { canDecide } from "../audit/policy.ts";
import type { CodeConfig } from "./config.ts";
import { jailList, jailRead, jailWrite } from "./jail.ts";
import { runCodeLoop, type CodeStep, type LoopDeps, type LoopStatus } from "./loop.ts";
import { runInWorktree } from "./sandbox.ts";
import { applyWorktree, createWorktree, discardWorktree, resetToIndex, snapshot, type Worktree } from "./worktree.ts";

export type CodeStatus = "running" | "review" | "no_changes" | "failed" | "cancelled" | "applied" | "rejected";
export type TestResult = { cmd: string; ok: boolean; exitCode: number | null; timedOut: boolean; output: string; at: number };
export type CodeTask = {
  id: string;
  goal: string;
  repo: string;
  baseRef: string;
  testCmd: string;
  status: CodeStatus;
  loopStatus?: LoopStatus;
  initiator: Initiator;
  createdAt: number;
  updatedAt: number;
  usd: number;
  steps: CodeStep[];
  summary: string;
  error?: string;
  wt?: Worktree;
  test?: TestResult;
  diff?: { text: string; stat: string; files: { status: string; path: string }[]; truncated: boolean };
  applied?: { head: string; into: string; at: number; by: string };
  pr: "off (D6)";
};

export function newTask(id: string, input: { goal: string; repo: string; baseRef?: string; testCmd?: string }, initiator: Initiator, now = Date.now()): CodeTask {
  return { id, goal: input.goal.slice(0, 4000), repo: input.repo, baseRef: (input.baseRef || "HEAD").slice(0, 200), testCmd: (input.testCmd ?? "").slice(0, 1000), status: "running", initiator, createdAt: now, updatedAt: now, usd: 0, steps: [], summary: "", pr: "off (D6)" };
}

export type TaskDeps = {
  llm: LoopDeps["llm"];
  save: (t: CodeTask) => void;
  signal: AbortSignal;
  /** Global meter check for an added estimate. */
  budget: (addUsd: number) => { ok: true } | { ok: false; error: string };
  estimate: number;
  run?: typeof runInWorktree;
};

const BASE_REF = /^[A-Za-z0-9._\/-]{1,200}$/;

export async function runCodeTask(task: CodeTask, cfg: CodeConfig, deps: TaskDeps): Promise<CodeTask> {
  const touch = () => {
    task.updatedAt = Date.now();
    deps.save(task);
  };
  const run = deps.run ?? runInWorktree;
  try {
    if (!BASE_REF.test(task.baseRef) || task.baseRef.startsWith("-")) throw new Error("invalid base ref");
    if (!task.wt) {
      const c = await createWorktree(cfg, task.repo, task.id, task.baseRef);
      if (!c.ok) throw new Error(c.error);
      task.wt = c.w;
      touch();
    }
    const wt = task.wt.wt;
    const loop = await runCodeLoop(
      task.goal,
      { testCmd: task.testCmd, files: jailList(wt, ".") },
      {
        llm: deps.llm,
        list: (p) => jailList(wt, p),
        read: (p) => jailRead(wt, p),
        write: (p, c) => jailWrite(wt, p, c),
        run: (cmd, signal) => run(wt, cmd, cfg.cmdTimeoutMs, signal),
        budget: (spent) => {
          if (spent + deps.estimate > cfg.runUsd) return { ok: false, error: `per-task cap $${cfg.runUsd.toFixed(2)} reached ($${spent.toFixed(3)} spent)` };
          return deps.budget(deps.estimate);
        },
        onStep: (_s, all) => {
          task.steps = all.slice();
          touch();
        },
        maxSteps: cfg.maxSteps,
        signal: deps.signal,
      },
    );
    task.steps = loop.steps;
    task.usd = loop.usd;
    task.summary = loop.summary;
    task.loopStatus = loop.status;
    touch();
    const snap = await snapshot(cfg, task.wt);
    task.diff = { text: snap.diff, stat: snap.stat, files: snap.files, truncated: snap.truncated };
    if (task.testCmd && loop.status !== "cancelled") {
      const r = await run(wt, task.testCmd, cfg.cmdTimeoutMs);
      task.test = { cmd: task.testCmd, ok: r.ok, exitCode: r.exitCode, timedOut: r.timedOut, output: r.output.slice(-20_000), at: Date.now() };
      await resetToIndex(cfg, task.wt);
    }
    if (loop.status === "cancelled") task.status = "cancelled";
    else if (loop.status === "error" && !snap.files.length) {
      task.status = "failed";
      task.error = loop.summary;
    } else task.status = snap.files.length ? "review" : "no_changes";
  } catch (error) {
    task.status = "failed";
    task.error = String(error instanceof Error ? error.message : error).slice(0, 300);
  }
  touch();
  return task;
}

export async function applyTask(task: CodeTask, cfg: CodeConfig, decider: Initiator): Promise<{ ok: true; task: CodeTask } | { ok: false; status: number; error: string }> {
  const d = canDecide(decider, task.initiator, "code.apply");
  if (!d.ok) return { ok: false, status: 403, error: d.reason };
  if (task.status !== "review" || !task.wt) return { ok: false, status: 409, error: `task is ${task.status}, not awaiting review` };
  const r = await applyWorktree(cfg, task.wt, `Sable code task ${task.id}: ${task.goal.split("\n")[0]!.slice(0, 120)}`);
  if (!r.ok) return { ok: false, status: 409, error: r.error };
  task.applied = { head: r.head, into: r.into, at: Date.now(), by: decider.id };
  task.status = "applied";
  await discardWorktree(cfg, task.wt, true);
  task.updatedAt = Date.now();
  return { ok: true, task };
}

export async function rejectTask(task: CodeTask, cfg: CodeConfig): Promise<{ ok: boolean; error?: string }> {
  if (task.status === "running" || task.status === "applied" || task.status === "rejected") return { ok: false, error: `task is ${task.status}` };
  if (task.wt) await discardWorktree(cfg, task.wt, true);
  task.status = "rejected";
  task.updatedAt = Date.now();
  return { ok: true };
}
