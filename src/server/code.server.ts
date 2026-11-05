/**
 * W4 code worktree agent server: task store (dataDir/code/<id>.json, 0600), owner-only start /
 * cancel / apply / reject, D7 heavy slot per task, per-task $ cap + global meter (scope "code").
 * Kill switch SABLE_CODEAGENT=0. bwrap required. GitHub PR off (D6); apply = local merge.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { codeConfig } from "@/lib/agent/code/config";
import { validateRepo } from "@/lib/agent/code/worktree";
import { applyTask, newTask, rejectTask, runCodeTask, type CodeTask } from "@/lib/agent/code/task";
import { codeSandboxReady } from "@/lib/agent/code/sandbox";
import { textCall } from "@/lib/agent/research/llm";
import { resolveEndpoints } from "@/lib/agent/provider";
import { estimateUsd } from "@/lib/agent/budget/prices";
import { plannerBundle } from "@/server/planner.server";
import { heavySlots } from "@/server/desktop.server";
import { audit } from "@/server/audit.server";
import { USER, type Initiator } from "@/lib/agent/audit/types";
import { dataDir } from "@/server/paths";

const KEY = Symbol.for("sable.code.v1");
type State = { ctl: Map<string, AbortController>; booted: boolean; busy: Set<string> };
function st(): State {
  const g = globalThis as unknown as Record<symbol, State | undefined>;
  return (g[KEY] ??= { ctl: new Map(), booted: false, busy: new Set() });
}
const dir = () => path.join(dataDir(), "code");
const fileOf = (id: string) => path.join(dir(), `${id}.json`);
export const validTaskId = (id: unknown): id is string => typeof id === "string" && /^[a-f0-9]{12}$/.test(id);
export const codeOn = () => codeConfig().enabled;

function save(t: CodeTask) {
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const tmp = `${fileOf(t.id)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(t), { mode: 0o600 });
  fs.renameSync(tmp, fileOf(t.id));
}
export function getTask(id: string): CodeTask | null {
  if (!validTaskId(id)) return null;
  try {
    return JSON.parse(fs.readFileSync(fileOf(id), "utf8")) as CodeTask;
  } catch {
    return null;
  }
}
function boot() {
  const s = st();
  if (s.booted) return;
  s.booted = true;
  for (const t of listTasks(true)) {
    if (t.status === "running" && !s.ctl.has(t.id)) {
      const full = getTask(t.id);
      if (!full) continue;
      full.status = "failed";
      full.error = "interrupted (server restart) — reject to clean up the worktree, then start again";
      save(full);
    }
  }
}
export function listTasks(raw = false) {
  if (!raw) boot();
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir()).filter((n) => /^[a-f0-9]{12}\.json$/.test(n));
  } catch {
    /* none yet */
  }
  const out = [];
  for (const n of names) {
    const t = getTask(n.slice(0, 12));
    if (t) out.push({ id: t.id, goal: t.goal.slice(0, 200), repo: t.repo, status: t.status, loopStatus: t.loopStatus ?? null, usd: t.usd, steps: t.steps.length, files: t.diff?.files.length ?? 0, testOk: t.test ? t.test.ok : null, createdAt: t.createdAt, updatedAt: t.updatedAt, live: st().ctl.has(t.id) });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt).slice(0, 100);
}
export function publicTask(t: CodeTask) {
  return { ...t, wt: t.wt ? { wt: t.wt.wt, branch: t.wt.branch, base: t.wt.base } : null, live: st().ctl.has(t.id) };
}
const endpoint = () => resolveEndpoints(process.env).find((e) => e.xai) ?? resolveEndpoints(process.env)[0] ?? null;

export function codeStatus() {
  boot();
  const cfg = codeConfig();
  return { enabled: cfg.enabled, model: cfg.model, sandbox: codeSandboxReady() ? "bwrap (no network)" : "missing", network: "off (no package-registry egress enabled)", github: "PR off (D6)", root: cfg.root, repoRoots: cfg.repoRoots, caps: { runUsd: cfg.runUsd, maxSteps: cfg.maxSteps, cmdTimeoutS: cfg.cmdTimeoutMs / 1000 }, configured: !!endpoint(), heavy: { active: heavySlots().active(), max: heavySlots().max() }, tasks: listTasks() };
}

type R = { ok: true; task: ReturnType<typeof publicTask> } | { ok: false; status: number; message: string };

export async function startCode(input: { repo: unknown; goal: unknown; testCmd?: unknown; baseRef?: unknown }): Promise<R> {
  boot();
  const cfg = codeConfig();
  if (!cfg.enabled) return { ok: false, status: 403, message: "Code agent đang tắt (SABLE_CODEAGENT=0)." };
  if (!codeSandboxReady()) return { ok: false, status: 409, message: "Thiếu bwrap — code agent cần sandbox." };
  const ep = endpoint();
  if (!ep) return { ok: false, status: 409, message: "Chưa cấu hình model." };
  const goal = typeof input.goal === "string" ? input.goal.trim() : "";
  if (!goal) return { ok: false, status: 400, message: "Cần mô tả việc (goal)." };
  const v = await validateRepo(cfg, input.repo);
  if (!v.ok) return { ok: false, status: 400, message: v.error };
  const id = crypto.randomBytes(6).toString("hex");
  const release = await heavySlots().acquire(`code:${id}`, { waitMs: 0 });
  if (!release) return { ok: false, status: 429, message: `Đã có ${heavySlots().max()} agent nặng đang chạy (D7). Thử lại sau.` };
  const task = newTask(id, { goal, repo: v.top, baseRef: typeof input.baseRef === "string" ? input.baseRef.trim() : undefined, testCmd: typeof input.testCmd === "string" ? input.testCmd.trim() : undefined }, USER);
  const ctl = new AbortController();
  st().ctl.set(id, ctl);
  save(task);
  const meter = plannerBundle().budget;
  audit({ type: "side_effect", initiator: USER, tool: "code.run", summary: `start ${id} in ${v.top}`, ok: true });
  void runCodeTask(task, cfg, {
    signal: ctl.signal,
    save,
    estimate: estimateUsd(cfg.model, 8_000, 1_500),
    budget: (add) => meter.check({ addUsd: add }),
    llm: async (messages, signal) => {
      const s = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
      const out = await textCall({ base: ep.base, key: ep.key, model: cfg.model, system: "", user: "", messages, json: true, maxTokens: 6000, signal: s });
      const ev = meter.record({ scope: "code", scopeId: `code:${id}`, model: cfg.model, promptTokens: out.promptTokens, completionTokens: out.completionTokens });
      return { text: out.text, usd: ev.usd };
    },
  }).finally(() => {
    st().ctl.delete(id);
    release();
    audit({ type: "side_effect", initiator: USER, tool: "code.run", summary: `task ${id} → ${task.status} (${task.diff?.files.length ?? 0} files, $${task.usd.toFixed(3)})`, ok: task.status === "review" });
    if (task.status !== "cancelled") void import("@/server/evals.server").then((m) => m.gradeCodeTask(task)).catch(() => undefined);
  });
  return { ok: true, task: publicTask(task) };
}

export function cancelCode(id: string): boolean {
  const c = st().ctl.get(id);
  if (!c) return false;
  c.abort();
  return true;
}

async function exclusive<T>(id: string, fn: () => Promise<T>): Promise<T | null> {
  const s = st();
  if (s.busy.has(id) || s.ctl.has(id)) return null;
  s.busy.add(id);
  try {
    return await fn();
  } finally {
    s.busy.delete(id);
  }
}

/** Owner approval → merge. `decider` comes from the route (always the web owner). */
export async function applyCode(id: string, decider: Initiator): Promise<R> {
  const t = getTask(id);
  if (!t) return { ok: false, status: 404, message: "not found" };
  const r = await exclusive(id, () => applyTask(t, codeConfig(), decider));
  if (!r) return { ok: false, status: 409, message: "task is busy" };
  audit({ type: "approval.decided", initiator: decider, tool: "code.apply", summary: r.ok ? `applied ${id} → ${t.applied?.into} @ ${t.applied?.head.slice(0, 10)}` : `apply ${id} refused: ${r.error}`, ok: r.ok });
  if (!r.ok) return { ok: false, status: r.status, message: r.error };
  save(t);
  return { ok: true, task: publicTask(t) };
}

export async function rejectCode(id: string): Promise<R> {
  const t = getTask(id);
  if (!t) return { ok: false, status: 404, message: "not found" };
  const r = await exclusive(id, () => rejectTask(t, codeConfig()));
  if (!r) return { ok: false, status: 409, message: "task is busy" };
  if (!r.ok) return { ok: false, status: 409, message: r.error ?? "cannot reject" };
  save(t);
  audit({ type: "approval.decided", initiator: USER, tool: "code.apply", summary: `rejected ${id} (worktree + branch removed)`, ok: true });
  return { ok: true, task: publicTask(t) };
}

export function deleteCode(id: string): boolean {
  const t = getTask(id);
  if (!t || st().ctl.has(id) || !(t.status === "applied" || t.status === "rejected")) return false;
  fs.unlinkSync(fileOf(id));
  return true;
}
