/**
 * W4 deep-research server: run store (dataDir/research/<id>.json, 0600; the checkpoints),
 * owner-only start/resume/cancel, D7 heavy slot, per-run $ cap + global meter, Canvas publish.
 * Kill switch SABLE_RESEARCH=0. Runs interrupted by a restart come back "paused" → owner resumes.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { researchConfig } from "@/lib/agent/research/config";
import { newRun, runResearch, type ResearchRun } from "@/lib/agent/research/pipeline";
import { textCall, xaiSearch } from "@/lib/agent/research/llm";
import { researchFetcher } from "@/lib/agent/research/fetcher";
import { parseAllowlist } from "@/lib/agent/tools/fetch";
import { resolveEndpoints } from "@/lib/agent/provider";
import { estimateUsd } from "@/lib/agent/budget/prices";
import { canvasStore } from "@/lib/agent/tools/canvas";
import { plannerBundle } from "@/server/planner.server";
import { heavySlots } from "@/server/desktop.server";
import { audit } from "@/server/audit.server";
import { USER } from "@/lib/agent/audit/types";
import { dataDir } from "@/server/paths";

const KEY = Symbol.for("sable.research.v1");

/** One provider call with its own timeout; one retry on a transient failure (never after the run was cancelled). */
async function withRetry<T>(signal: AbortSignal, ms: number, fn: (s: AbortSignal) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn(AbortSignal.any([signal, AbortSignal.timeout(ms)]));
    } catch (error) {
      if (signal.aborted || attempt >= 1 || /HTTP 4(0[0-9]|1[0-9]|2[0-8])\b/.test(String((error as Error)?.message))) throw error;
    }
  }
}
type State = { ctl: Map<string, AbortController>; booted: boolean };
function st(): State {
  const g = globalThis as unknown as Record<symbol, State | undefined>;
  return (g[KEY] ??= { ctl: new Map(), booted: false });
}
const dir = () => path.join(dataDir(), "research");
const fileOf = (id: string) => path.join(dir(), `${id}.json`);
export const validRunId = (id: unknown): id is string => typeof id === "string" && /^[a-f0-9]{16}$/.test(id);

export function researchOn() {
  return researchConfig().enabled;
}

function save(run: ResearchRun) {
  fs.mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const tmp = `${fileOf(run.id)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(run), { mode: 0o600 });
  fs.renameSync(tmp, fileOf(run.id));
}
export function getRun(id: string): ResearchRun | null {
  if (!validRunId(id)) return null;
  try {
    return JSON.parse(fs.readFileSync(fileOf(id), "utf8")) as ResearchRun;
  } catch {
    return null;
  }
}
function boot() {
  const s = st();
  if (s.booted) return;
  s.booted = true;
  // A run marked running on disk but not in this process was interrupted (restart/suspend).
  for (const r of listRuns(true)) {
    if (r.status === "running" && !s.ctl.has(r.id)) {
      const full = getRun(r.id);
      if (!full) continue;
      full.status = "paused";
      full.error = "interrupted (server restart) — resume continues from the last checkpoint";
      for (const step of full.steps) if (step.status === "running") step.status = "pending";
      save(full);
    }
  }
}
export function listRuns(raw = false) {
  if (!raw) boot();
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir()).filter((n) => /^[a-f0-9]{16}\.json$/.test(n));
  } catch {
    /* none yet */
  }
  const out = [];
  for (const n of names) {
    const r = getRun(n.slice(0, 16));
    if (r) out.push(summary(r));
  }
  return out.sort((a, b) => b.createdAt - a.createdAt).slice(0, 100);
}
/** Public view: no full page texts (only passages count / excerpts used). */
export function publicRun(r: ResearchRun) {
  return { ...r, sources: r.sources.map(({ text: _t, passages: p, ...rest }) => ({ ...rest, passages: p?.length ?? 0 })), live: st().ctl.has(r.id) };
}
function summary(r: ResearchRun) {
  return { id: r.id, question: r.question.slice(0, 200), status: r.status, usd: r.usd, ops: r.ops, createdAt: r.createdAt, updatedAt: r.updatedAt, canvasId: r.canvasId ?? null, stats: r.report?.stats ?? null, live: st().ctl.has(r.id) };
}

function endpoint() {
  const eps = resolveEndpoints(process.env);
  return eps.find((e) => e.xai) ?? null;
}

export function researchStatus() {
  boot();
  const cfg = researchConfig();
  return { enabled: cfg.enabled, model: cfg.model, caps: { runUsd: cfg.runUsd, maxSteps: cfg.maxSteps, maxSources: cfg.maxSources, maxQueries: cfg.maxQueries }, configured: !!endpoint(), heavy: { active: heavySlots().active(), max: heavySlots().max() }, runs: listRuns() };
}

type Start = { ok: true; run: ReturnType<typeof publicRun> } | { ok: false; status: number; message: string };

/** Owner-only (route passes USER). Starts a new run or resumes a paused/capped one. */
export async function startResearch(question: string, resumeId?: string): Promise<Start> {
  boot();
  const cfg = researchConfig();
  if (!cfg.enabled) return { ok: false, status: 403, message: "Research đang tắt (SABLE_RESEARCH=0)." };
  const ep = endpoint();
  if (!ep) return { ok: false, status: 409, message: "Chưa cấu hình xAI (cần web_search)." };
  let run: ResearchRun | null;
  if (resumeId) {
    run = getRun(resumeId);
    if (!run) return { ok: false, status: 404, message: "Không tìm thấy run." };
    if (st().ctl.has(run.id)) return { ok: false, status: 409, message: "Run đang chạy." };
    if (run.status === "done") return { ok: false, status: 409, message: "Run đã xong." };
  } else {
    if (!question.trim()) return { ok: false, status: 400, message: "Cần câu hỏi." };
    run = newRun(crypto.randomBytes(8).toString("hex"), question.trim(), USER);
  }
  const release = await heavySlots().acquire(`research:${run.id}`, { waitMs: 0 });
  if (!release) return { ok: false, status: 429, message: `Đã có ${heavySlots().max()} agent nặng đang chạy (D7). Thử lại sau.` };
  const ctl = new AbortController();
  st().ctl.set(run.id, ctl);
  save(run);
  const meter = plannerBundle().budget;
  const fetcher = researchFetcher({ allow: parseAllowlist(process.env.SABLE_FETCH_ALLOW), fakeIpEgress: process.env.SABLE_FETCH_FAKE_IP === "1" });
  const scopeId = `research:${run.id}`;
  audit({ type: "side_effect", initiator: USER, tool: "research.run", summary: `${resumeId ? "resume" : "start"} ${run.id}`, ok: true });
  const r = run;
  void runResearch(r, {
    signal: ctl.signal,
    caps: cfg,
    estimate: { llm: estimateUsd(cfg.model, 6_000, 1_500), search: estimateUsd(cfg.searchModel, 20_000, 1_500) + 0.025 },
    budget: (add) => meter.check({ addUsd: add }),
    save,
    llm: async ({ system, user, json, maxTokens, signal }) => {
      const out = await withRetry(signal, 120_000, (s) => textCall({ base: ep.base, key: ep.key, model: cfg.model, system, user, json, maxTokens, signal: s }));
      const ev = meter.record({ scope: "research", scopeId, model: cfg.model, promptTokens: out.promptTokens, completionTokens: out.completionTokens });
      return { text: out.text, usd: ev.usd };
    },
    search: async (query, signal) => {
      const out = await withRetry(signal, 120_000, (s) => xaiSearch({ base: ep.base, key: ep.key, model: cfg.searchModel, query, signal: s }));
      const ev = meter.record({ scope: "research", scopeId, model: cfg.searchModel, promptTokens: out.promptTokens, completionTokens: out.completionTokens });
      return { hits: out.hits, usd: ev.usd + 0.025 }; // + server-side search tool fee (approx.)
    },
    fetch: fetcher,
    publish: async (title, html, canvasId) => {
      const store = canvasStore();
      const res = canvasId && store.get(canvasId) ? store.update(canvasId, { title, html, note: `research ${r.id}`, by: "agent" }) : store.create({ title, html, note: `research ${r.id}`, by: "agent" });
      if (!res.ok) throw new Error(res.error);
      return res.canvas.id;
    },
  })
    .catch((error) => {
      r.status = "failed";
      r.error = String(error instanceof Error ? error.message : error).slice(0, 300);
      save(r);
    })
    .finally(() => {
      st().ctl.delete(r.id);
      release();
      audit({ type: "side_effect", initiator: USER, tool: "research.run", summary: `run ${r.id} → ${r.status} ($${r.usd.toFixed(3)})`, ok: r.status === "done" });
    });
  return { ok: true, run: publicRun(run) };
}

export function cancelResearch(id: string): boolean {
  const c = st().ctl.get(id);
  if (!c) return false;
  c.abort();
  return true;
}

export function deleteResearch(id: string): boolean {
  if (!validRunId(id) || st().ctl.has(id)) return false;
  try {
    fs.unlinkSync(fileOf(id));
    return true;
  } catch {
    return false;
  }
}
