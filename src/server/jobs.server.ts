/**
 * Background jobs + routines + inbox, wired to the real agent loop. One
 * service per server process (globalThis singleton, survives SSR module
 * reloads). Jobs run in-process: they keep going when the tab closes, and a
 * restart requeues (once) or fails whatever was mid-run.
 */
import path from "node:path";
import { parseChatRequest } from "@/lib/agent/harness";
import { runAgent } from "@/lib/agent/loop";
import { createSpawner } from "@/server/spawn.server";
import { claimDataDir, JobDb } from "@/lib/agent/jobs/db";
import { deliverApproval, deliverResult, settleApproval, unreadCount } from "@/lib/agent/jobs/inbox";
import { compactRequest, initiatorFor, JobRunner, type JobExec } from "@/lib/agent/jobs/runner";
import { auditJobAsk, auditSink } from "@/server/audit.server";
import { RoutineScheduler } from "@/lib/agent/jobs/scheduler";
import { triggerView, type CheckResult } from "@/lib/agent/jobs/triggers";
import { createHttpFetch } from "@/lib/agent/tools/fetch";
import { describeSchedule } from "@/lib/agent/jobs/schedule";
import { isActive, summarize, type Job, type Routine } from "@/lib/agent/jobs/types";
import type { ToolContext } from "@/lib/agent/tools/types";
import { prepareTurn, workspaceDir } from "@/server/chat.server";
import { emitJobEvent } from "@/server/channel-bus";
import { catchUpOn, tickHeartbeat } from "@/lib/agent/resilience/heartbeat";
import { plannerBundle } from "@/server/planner.server";
import { makeAssertScope } from "@/server/scope.server";

function num(name: string, fallback: number, min: number, max: number) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.min(max, Math.max(min, raw)) : fallback;
}

function flagOn(name: string) {
  return (process.env[name] ?? "1").trim() !== "0";
}

export function isNoChange(job: Job) {
  return job.kind === "routine" && job.status === "done" && /^\s*NO_CHANGE\s*\.?\s*$/.test(job.text);
}

/** Watched URLs go through http_fetch itself: same SSRF guards, redirects re-checked, 2 MB cap. */
const watchTool = createHttpFetch();
async function watchFetch(url: string, signal: AbortSignal): Promise<CheckResult> {
  try {
    const res = await watchTool.run({ url }, { signal } as unknown as ToolContext);
    const body = res.output.replace(/^UNTRUSTED CONTENT from [^\n]*\n\n/, "");
    return res.ok ? { ok: true, text: body } : { ok: false, error: res.output.slice(0, 160) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function jobConfig() {
  const approvalMin = Number(process.env.SABLE_JOB_APPROVAL_TTL_MIN);
  return {
    jobsOn: flagOn("SABLE_JOBS"),
    routinesOn: flagOn("SABLE_ROUTINES") && flagOn("SABLE_JOBS"),
    triggersOn: flagOn("SABLE_TRIGGERS") && flagOn("SABLE_ROUTINES") && flagOn("SABLE_JOBS"),
    concurrency: Math.round(num("SABLE_JOB_CONCURRENCY", 2, 1, 8)),
    maxSteps: Math.round(num("SABLE_JOB_MAX_STEPS", 20, 1, 50)),
    timeoutMs: num("SABLE_JOB_TIMEOUT_MIN", 20, 1, 360) * 60_000,
    approvalTtlMs:
      Number.isFinite(approvalMin) && approvalMin > 0
        ? Math.min(7 * 1440, approvalMin) * 60_000
        : num("SABLE_JOB_APPROVAL_TTL_H", 24, 0.1, 168) * 3_600_000,
    recovery:
      (process.env.SABLE_JOB_RECOVERY ?? "requeue").trim() === "fail"
        ? ("fail" as const)
        : ("requeue" as const),
    catchUpMs: flagOn("SABLE_CATCHUP") && flagOn("SABLE_ROUTINE_CATCHUP")
      ? num("SABLE_ROUTINE_CATCHUP_HOURS", 24, 0.1, 24 * 14) * 3_600_000
      : 0,
    tickMs: Math.round(num("SABLE_ROUTINE_TICK_SEC", 30, 5, 300) * 1000),
  };
}

export { dataDir } from "@/server/paths";
import { dataDir } from "@/server/paths";
import { mcpWarm } from "@/server/mcp.server";

const BACKGROUND_NOTE =
  "This turn runs as a background job: nobody is watching live and nobody can answer questions. Finish the task on your own and end with the final result. File writes still wait for the user's approval in the Sable UI; if one is rejected, carry on without it.";

const exec: JobExec = async (job, io) => {
  await mcpWarm();
  const turn = prepareTurn(job.request, BACKGROUND_NOTE, { mode: "background", source: job.routineId ? "routine" : "job", sourceRef: job.id, mcp: true });
  if (!turn) throw new Error("Mô hình chưa sẵn sàng trong môi trường này.");
  for (const text of turn.notices) io.emit({ event: "notice", data: { text } });
  const { workspaces, budget } = plannerBundle();
  const wsId = job.workspaceId ?? job.taskId;
  if (wsId) workspaces.ensure(wsId);
  const taskWs = workspaces.resolve(wsId);
  const budgetOk = budget.check();
  if (!budgetOk.ok) throw new Error(budgetOk.error);
  const ctx: ToolContext = {
    workspaceDir: taskWs,
    signal: io.signal,
    mode: "background",
    approve: io.approve,
    memory: turn.memory,
    skills: turn.skills,
    scopeId: job.scopeId ?? null,
    assertScope: makeAssertScope(job.scopeId ?? null, "background"),
    initiator: job.initiator ?? initiatorFor(job),
    audit: auditSink(job.id),
  };
  if (turn.functions.some((tool) => tool.name === "spawn_agent")) ctx.spawn = createSpawner(turn, turn.active, io.emit);
  const result = await runAgent(turn.assembled, {
    adapter: turn.adapter,
    transport: turn.transport,
    tools: turn.functions,
    ctx,
    emit: io.emit,
    opts: turn.opts,
    maxSteps: job.maxSteps,
  });
  return { stopped: result.stopped };
};

type Service = {
  db: JobDb;
  runner: JobRunner;
  scheduler: RoutineScheduler;
  /** Another live server process owns the data dir: this one runs nothing. */
  foreignOwner: number | null;
};
const KEY = Symbol.for("sable.jobs.service.v1");

const RECLAIM_EVERY_MS = 5_000;
let lastReclaim = 0;

export function jobService(): Service {
  const scope = globalThis as unknown as Record<symbol, Service | undefined>;
  const existing = scope[KEY];
  if (existing && existing.foreignOwner === null) return existing;
  if (existing) {
    // Started while an old server still held the data dir: take over once it is gone,
    // reloading from disk (its cache is stale) and running recovery then.
    const now = Date.now();
    if (now - lastReclaim < RECLAIM_EVERY_MS) return existing;
    lastReclaim = now;
    if (claimDataDir(dataDir()) !== null) return existing;
    scope[KEY] = undefined;
  }
  const config = jobConfig();
  const dir = dataDir();
  const db = new JobDb(dir);
  const foreignOwner = claimDataDir(dir);
  if (foreignOwner !== null)
    console.warn(
      `[sable-jobs] data dir is in use by another server (pid ${foreignOwner}); background jobs and routines are off in this process`,
    );
  const runner = new JobRunner({
    db,
    exec,
    concurrency: config.concurrency,
    approvalTtlMs: config.approvalTtlMs,
    recovery: config.recovery,
    enabled: () => foreignOwner === null && jobConfig().jobsOn,
    onFinish: (job) => {
      // Quiet run: a routine that answers exactly NO_CHANGE leaves no inbox item / ping.
      if (isNoChange(job)) {
        job.skippedReason = "unchanged";
        deliverResult(db, { ...job, status: "cancelled" });
        return;
      }
      deliverResult(db, job);
      emitJobEvent("finish", job);
    },
    onWaiting: (job, approval) => {
      deliverApproval(db, job, approval);
      auditJobAsk(job, approval);
      emitJobEvent("waiting", job, approval);
    },
    onApprovalSettled: (job, approval) => {
      settleApproval(db, job, approval);
      emitJobEvent("settled", job, approval);
    },
  });
  const scheduler = new RoutineScheduler({
    db,
    runner,
    enabled: () => foreignOwner === null && jobConfig().routinesOn,
    catchUpMs: config.catchUpMs,
    tickMs: config.tickMs,
    jobTimeoutMs: config.timeoutMs,
    maxStepsCap: config.maxSteps,
    triggersOn: () => jobConfig().triggersOn,
    watchFetch,
    watchTickMs: num("SABLE_WATCH_TICK_S", 60, 5, 600) * 1000,
  });
  const service = { db, runner, scheduler, foreignOwner };
  scope[KEY] = service;
  if (foreignOwner !== null) return service;
  const recovered = runner.recover();
  if (recovered.requeued || recovered.failed || recovered.cancelled) {
    console.log(
      `[sable-jobs] restart recovery: ${recovered.requeued} requeued, ${recovered.failed} failed, ${recovered.cancelled} cancelled`,
    );
  }
  const beat = tickHeartbeat(dir);
  if (beat.wokeFromSuspend) {
    console.log(
      `[sable-jobs] wake after gap ${beat.lastGapMs}ms; catch-up ${catchUpOn() ? "enabled" : "disabled (SABLE_CATCHUP=0)"}`,
    );
  }
  scheduler.start();
  runner.pump();
  // Outside channels (Telegram / SMTP) live only in the process that owns the data dir.
  void import("@/server/channels.server")
    .then((mod) => mod.startChannels())
    .catch((error) => console.warn(`[sable-channels] not started: ${error instanceof Error ? error.message : String(error)}`));
  void import("@/server/proactive.server")
    .then((mod) => mod.startBriefTicker())
    .catch((error) => console.warn(`[sable-brief] ticker not started: ${error instanceof Error ? error.message : String(error)}`));
  void import("@/server/connectors.server")
    .then((mod) => mod.startConnectorTicker())
    .catch((error) => console.warn(`[sable-connectors] ticker not started: ${error instanceof Error ? error.message : String(error)}`));
  return service;
}

export function jobsOverview() {
  const { db, runner, scheduler } = jobService();
  const config = { ...jobConfig(), jobsOn: runner.enabled(), routinesOn: scheduler.enabled() };
  const jobs = db.listJobs();
  return {
    enabled: config.jobsOn,
    routinesEnabled: config.routinesOn,
    triggersEnabled: config.triggersOn && scheduler.enabled(),
    config: {
      concurrency: config.concurrency,
      maxSteps: config.maxSteps,
      timeoutMin: Math.round(config.timeoutMs / 60_000),
      approvalTtlHours: Math.round((config.approvalTtlMs / 3_600_000) * 10) / 10,
    },
    counts: {
      active: jobs.filter((job) => isActive(job.status)).length,
      waiting: jobs.filter((job) => job.status === "waiting_approval").length,
    },
    unread: unreadCount(db),
    jobs: jobs.slice(0, 100).map(summarize),
  };
}

export function jobDetail(id: string): Job | undefined {
  return jobService().db.getJob(id);
}

/** What the UI polls every 1.5 s: the job without its (possibly 1.5 MB) chat history and attachments. */
export function jobView(id: string): Job | undefined {
  const job = jobDetail(id);
  return job ? { ...job, request: compactRequest(job.request) } : undefined;
}

export function createJob(body: unknown, title?: string) {
  const parsed = parseChatRequest(body);
  if (!parsed.ok) return { ok: false as const, status: 400, message: parsed.error };
  const config = jobConfig();
  if (!jobService().runner.enabled())
    return {
      ok: false as const,
      status: 503,
      message: "Việc nền đang tắt trên máy chủ (SABLE_JOBS=0).",
    };
  const job = jobService().runner.enqueue({
    title,
    request: parsed.request,
    maxSteps: config.maxSteps,
    timeoutMs: config.timeoutMs,
  });
  return { ok: true as const, job };
}

export function routineView(routine: Routine) {
  return { ...routine, trigger: triggerView(routine.trigger), scheduleLabel: describeSchedule(routine.schedule) };
}
