/**
 * W5 self-eval server: per-run grading (rules, or rules + light model when SABLE_MODEL_LIGHT is
 * set), failures → review queue (shown in the Tasks inbox), nightly regression routine (builtin,
 * default OFF) that runs eval suites as child processes with a minimal env (never Sable's env /
 * keys, always --no-llm) and reports pass/fail diffs. Regressions become PROPOSALS only — nothing
 * here edits code, prompts or settings; the owner decides. Kill switch SABLE_SELFEVAL=0.
 */
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { blend, judgePrompt, JUDGE_SYSTEM, parseJudge, ruleGrade, type Grade, type RunKind, type RunRecord } from "@/lib/agent/evals/grader";
import { EvalStore, type EvalSettings, type RegressRun, type ReviewItem, type ReviewState, type SuiteResult } from "@/lib/agent/evals/store";
import { diffRuns, parseEvalOutput, proposalsFor } from "@/lib/agent/evals/regress";
import { redactSecrets } from "@/lib/agent/memory/redact";
import type { ClientEvent } from "@/lib/agent/harness";
import type { ChatRequest } from "@/lib/agent/types";
import { localParts } from "@/lib/agent/proactive/brief";
import { dataDir } from "@/server/paths";

export const NIGHTLY_ROUTINE_ID = "builtin:nightly-eval";

export function selfEvalOn() {
  return process.env.SABLE_SELFEVAL !== "0";
}

type State = { store: EvalStore | null; running: Promise<RegressRun | null> | null; runningSince: number; current: string };
const KEY = Symbol.for("sable.evals.v1");
function st(): State {
  const g = globalThis as unknown as Record<symbol, State | undefined>;
  return (g[KEY] ??= { store: null, running: null, runningSince: 0, current: "" });
}
export function evalStore(): EvalStore {
  return (st().store ??= new EvalStore(path.join(dataDir(), "evals")));
}

const newId = (p: string) => `${p}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
/** Parse check names from the raw output (they are our own script's labels), then redact everything kept as text. */
function safeParse(suite: string, out: string, code: number | null, ms: number) {
  const r = parseEvalOutput(suite, out, code, ms);
  const checks: typeof r.checks = {};
  for (const [k, v] of Object.entries(r.checks)) {
    const red = redactSecrets(k).text;
    checks[red === k ? k : `${suite}/[redacted-${Object.keys(checks).length}]`] = v;
  }
  return { ...r, checks, tail: redactSecrets(r.tail).text };
}

const clip = (s: string, n: number) => redactSecrets(s.replace(/\s+/g, " ").trim()).text.slice(0, n);
const URL_RE = /https?:\/\/[^\s)<>\]"'`]+/g;

/** Collects what a run did from its event stream (steps, sources, citations, approvals). */
export function runRecorder(kind: RunKind, ref: string, input: Pick<ChatRequest, "messages">) {
  const goal = [...input.messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const tools = new Set<string>();
  const seen = new Set<string>((input.messages.filter((m) => m.role === "user").map((m) => m.content).join(" ").match(URL_RE) ?? []));
  const notices: string[] = [];
  const approvals = new Map<string, string>();
  let answer = "";
  const t0 = Date.now();
  return {
    tap(e: ClientEvent) {
      if (e.event === "delta") answer += e.data.text;
      else if (e.event === "step") {
        if (e.data.tool) tools.add(e.data.tool);
        else if (e.data.kind === "web") tools.add("web_search");
        else if (e.data.kind === "x") tools.add("x_search");
        for (const s of e.data.sources ?? []) seen.add(s);
        for (const u of `${e.data.label} ${e.data.detail ?? ""}`.match(URL_RE) ?? []) seen.add(u);
      } else if (e.event === "citation") seen.add(e.data.url);
      else if (e.event === "notice") notices.push(e.data.text);
      else if (e.event === "approval") approvals.set(e.data.id, e.data.state);
    },
    record(extra: { answer?: string; error?: string; stopped?: string } = {}): RunRecord {
      return { kind, ref, goal, answer: extra.answer ?? answer, tools: [...tools], seenUrls: [...seen], notices, approvals: [...approvals.values()], error: extra.error, stopped: extra.stopped, ms: Date.now() - t0 };
    },
  };
}

async function judge(rec: RunRecord, rule: Grade): Promise<Grade> {
  const model = process.env.SABLE_MODEL_LIGHT?.trim();
  if (!model) return rule;
  try {
    const { completerFor } = await import("@/server/memory.server");
    const { prepareTurn } = await import("@/server/chat.server");
    const req: ChatRequest = { model, effort: "low", instructions: "", memory: "", messages: [{ role: "user", content: "grade" }], tools: { web: false, x: false, code: false, image: false }, remember: false };
    const complete = completerFor(() => prepareTurn(req));
    const text = await complete(JUDGE_SYSTEM, judgePrompt(rec, rule), AbortSignal.timeout(30_000));
    return blend(rule, parseJudge(text), model);
  } catch {
    return rule;
  }
}

/** Grade one finished run (never throws; never blocks the caller). */
export async function gradeRun(rec: RunRecord): Promise<Grade | null> {
  if (!selfEvalOn()) return null;
  try {
    const g = await judge(rec, ruleGrade(rec));
    const id = newId("grd");
    const store = evalStore();
    store.addGrade({ id, at: Date.now(), kind: rec.kind, ref: rec.ref, goal: clip(rec.goal, 300), answer: clip(rec.answer, 300), ms: rec.ms, ...g });
    if (g.failed) {
      store.addReview({
        id: newId("rev"),
        at: Date.now(),
        type: "failed_run",
        title: `Lượt ${rec.kind} chấm thấp: ${clip(rec.goal, 80) || rec.ref}`,
        detail: `thành công ${g.success} · bám nguồn ${g.grounded} · ${g.reason}`.slice(0, 600),
        state: "open",
        gradeId: id,
        runKind: rec.kind,
        ref: rec.ref,
      });
    }
    return g;
  } catch (error) {
    console.warn(`[sable-evals] grade failed: ${error instanceof Error ? error.message.slice(0, 160) : "error"}`);
    return null;
  }
}

export function gradeResearchRun(r: { id: string; question?: string; status: string; error?: string; report?: { stats?: { claims?: number; supported?: number; weak?: number; unsupported?: number }; summary?: string } }) {
  const s = r.report?.stats ?? {};
  void gradeRun({ kind: "research", ref: r.id, goal: r.question ?? "", answer: r.report?.summary ?? "", tools: ["web_search", "http_fetch"], seenUrls: [], notices: [], approvals: [], error: r.error, research: { status: r.status, claims: s.claims ?? 0, supported: s.supported ?? 0, weak: s.weak ?? 0, unsupported: s.unsupported ?? 0 } });
}

export function gradeCodeTask(t: { id: string; goal: string; status: string; summary?: string; test?: { ok: boolean }; diff?: { files: unknown[] } }) {
  void gradeRun({ kind: "code", ref: t.id, goal: t.goal, answer: t.summary ?? "", tools: [], seenUrls: [], notices: [], approvals: [], code: { status: t.status, testsOk: t.test ? t.test.ok : null, files: t.diff?.files.length ?? 0 } });
}

export function setReviewState(id: string, state: ReviewState) {
  return evalStore().setReview(id, state);
}
export function openReviews(): ReviewItem[] {
  return evalStore().reviews().filter((r) => r.state === "open");
}

// ── Nightly regression ───────────────────────────────────────────────────────

const SUITE_TIMEOUT_MS = 15 * 60_000;

/** Child env: minimal, never Sable's own env (no API keys, no passwords). */
function childEnv(): NodeJS.ProcessEnv {
  return { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: process.env.HOME || "/tmp", LANG: "C.UTF-8", TERM: "dumb", CI: "1", SABLE_DATA_DIR: dataDir(), SABLE_EVAL_NIGHTLY: "1" };
}

function runSuite(suite: string, cwd: string): Promise<SuiteResult> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    let out = "";
    const child = spawn("npm", ["run", "-s", `eval:${suite}`, "--", "--no-llm"], { cwd, env: childEnv(), stdio: ["ignore", "pipe", "pipe"] });
    const onData = (b: Buffer) => {
      out += b.toString("utf8");
      if (out.length > 400_000) out = out.slice(-200_000);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const timer = setTimeout(() => child.kill("SIGKILL"), SUITE_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(safeParse(suite, out, code, Date.now() - t0));
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(safeParse(suite, out, -1, Date.now() - t0));
    });
  });
}

export function regressionRunning() {
  const s = st();
  return s.running ? { since: s.runningSince, suite: s.current } : null;
}

export async function runRegression(opts: { manual: boolean; suites?: string[]; cwd?: string }): Promise<RegressRun | null> {
  const s = st();
  if (s.running) return s.running;
  const store = evalStore();
  const suites = (opts.suites?.length ? opts.suites : store.settings().suites).slice(0, 12);
  s.runningSince = Date.now();
  s.running = (async () => {
    try {
      const results: SuiteResult[] = [];
      for (const suite of suites) {
        s.current = suite;
        results.push(await runSuite(suite, opts.cwd ?? process.cwd()));
      }
      const prev = store.regressRuns()[0] ?? null;
      const diff = diffRuns(prev, results);
      const run: RegressRun = { id: newId("reg"), at: Date.now(), manual: opts.manual, suites: results, diff, ok: results.every((r) => r.fail === 0 && r.code === 0), ms: Date.now() - s.runningSince };
      store.addRegress(run);
      for (const p of proposalsFor(diff, results)) store.addReview({ id: newId("rev"), at: Date.now(), type: "regression_proposal", title: p.title, detail: p.detail.slice(0, 1500), proposal: p.proposal, state: "open", regressId: run.id });
      console.log(`[sable-evals] regression ${run.id}: ${results.map((r) => `${r.suite} ${r.pass}/${r.fail}/${r.skip}`).join(", ")}; newly failing ${diff.newlyFailing.length}`);
      return run;
    } catch (error) {
      console.warn(`[sable-evals] regression failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    } finally {
      s.running = null;
      s.current = "";
    }
  })();
  return s.running;
}

export function nightlyRoutineDef(cfg: EvalSettings = evalStore().settings()) {
  const [h, m] = cfg.time.split(":").map((n) => Number(n));
  return {
    id: NIGHTLY_ROUTINE_ID,
    builtin: "nightly-eval",
    name: "Eval hồi quy ban đêm",
    prompt: "(tích hợp) Chạy các bộ eval (--no-llm), so sánh với lần trước, tạo đề xuất cho chủ duyệt. Không tự sửa code hay prompt.",
    schedule: { kind: "cron" as const, expr: `${m} ${h} * * *` },
    tz: cfg.tz,
    enabled: selfEvalOn() && cfg.nightly,
    catchUp: false,
  };
}

export async function syncNightlyRoutine() {
  const { jobService } = await import("@/server/jobs.server");
  const { scheduler, foreignOwner } = jobService();
  if (foreignOwner !== null) return null;
  return scheduler.upsertBriefSafe(nightlyRoutineDef());
}

export function fireNightlyEval(scheduledFor: number, opts: { manual: boolean }): string {
  if (!selfEvalOn()) return "Self-eval tắt (SABLE_SELFEVAL=0) — bỏ qua.";
  const store = evalStore();
  if (!opts.manual) {
    const cfg = store.settings();
    const slot = localParts(new Date(scheduledFor), cfg.tz).date;
    if (cfg.lastSlot === slot) return `Đã chạy eval đêm ${slot} — bỏ qua.`;
    store.setSettings({ lastSlot: slot });
  }
  if (st().running) return "Đang chạy một lượt eval — bỏ qua.";
  void runRegression({ manual: opts.manual });
  return opts.manual ? "Chạy tay eval hồi quy." : "Bắt đầu eval hồi quy ban đêm.";
}

export async function updateEvalSettings(patch: Partial<EvalSettings>) {
  const next = evalStore().setSettings({ nightly: patch.nightly, time: patch.time, suites: patch.suites });
  try {
    await syncNightlyRoutine();
  } catch (error) {
    console.warn(`[sable-evals] routine sync failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return next;
}

export function evalsView() {
  const store = evalStore();
  const grades = store.grades(100);
  const n = grades.length || 1;
  return {
    enabled: selfEvalOn(),
    grader: process.env.SABLE_MODEL_LIGHT?.trim() ? `rules+${process.env.SABLE_MODEL_LIGHT.trim()}` : "rules",
    summary: { runs: grades.length, failed: grades.filter((g) => g.failed).length, avgSuccess: Math.round((grades.reduce((a, g) => a + g.success, 0) / n) * 100) / 100, avgGrounded: Math.round((grades.reduce((a, g) => a + g.grounded, 0) / n) * 100) / 100 },
    grades: grades.slice(0, 50),
    reviews: store.reviews().slice(0, 100),
    settings: store.settings(),
    routineId: NIGHTLY_ROUTINE_ID,
    regress: store.regressRuns().slice(0, 10),
    running: regressionRunning(),
  };
}
