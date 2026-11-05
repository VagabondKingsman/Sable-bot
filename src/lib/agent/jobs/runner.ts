/**
 * In-process job runner: runs the Phase 1 agent loop without a browser.
 * Queue with limited concurrency, cancel, per-job step cap (passed to the
 * exec), wall-clock budget that pauses while a write waits for approval, and
 * restart recovery. Writes are never auto-approved: a write pauses the job as
 * waiting_approval until the user decides or the (long) approval TTL expires,
 * and expiry counts as rejection.
 */
import { mergeTrace, type ClientEvent } from "../harness.ts";
import { createApprovals, type Approvals } from "../tools/approvals.ts";
import type { ApprovalAsk } from "../tools/types.ts";
import type { ChatRequest } from "../types.ts";
import type { JobDb } from "./db.ts";
import { isActive, type Job, type JobApproval, type JobStatus } from "./types.ts";

export type JobIO = {
  signal: AbortSignal;
  emit: (event: ClientEvent) => void;
  approve: (ask: ApprovalAsk) => Promise<boolean>;
};

export type JobExec = (job: Job, io: JobIO) => Promise<{ stopped?: "max_steps" } | void>;

export type RunnerOptions = {
  db: JobDb;
  exec: JobExec;
  concurrency?: number;
  approvalTtlMs?: number;
  /** Runs per job, counting restarts (requeue stops after this many). */
  maxAttempts?: number;
  recovery?: "requeue" | "fail";
  /** SABLE_JOBS kill switch: false → refuse new jobs, start none. */
  enabled?: () => boolean;
  now?: () => number;
  flushMs?: number;
  /** After cancel/timeout, how long an exec that ignores the abort may take before the job is closed anyway. */
  abortGraceMs?: number;
  /** Called once per job when it reaches a final state (done, failed or cancelled). */
  onFinish?: (job: Job) => void;
  onWaiting?: (job: Job, approval: JobApproval) => void;
  /** an ask was approved, rejected or expired */
  onApprovalSettled?: (job: Job, approval: JobApproval) => void;
};

export type EnqueueInput = {
  title?: string;
  kind?: Job["kind"];
  routineId?: string;
  scheduledFor?: number;
  catchUp?: boolean;
  manual?: boolean;
  origin?: Job["origin"];
  initiator?: Job["initiator"];
  request: ChatRequest;
  maxSteps: number;
  timeoutMs: number;
};

/** Default initiator for a job when the caller did not say (W2a audit). */
export function initiatorFor(input: Pick<EnqueueInput, "origin" | "routineId" | "manual">): NonNullable<Job["initiator"]> {
  if (input.origin?.channel === "telegram") return { kind: "channel", id: `telegram:${input.origin.chatId}` };
  if (input.origin?.channel === "webhook") return { kind: "channel", id: `webhook:${input.origin.peerId}` };
  if (input.routineId && !input.manual) return { kind: "routine", id: input.routineId };
  return { kind: "user", id: input.routineId ? `owner:run-now:${input.routineId}` : "owner:web" };
}

export class JobsDisabledError extends Error {
  constructor() {
    super("Việc nền đang tắt trên máy chủ (SABLE_JOBS=0).");
  }
}

const MAX_TEXT = 200_000;
const MAX_STEPS_KEPT = 300;
const MAX_NOTICES = 30;
/** A finished job keeps only the prompt it was given (attachments/history dropped). */
const KEPT_PROMPT = 20_000;

export function compactRequest(request: ChatRequest): ChatRequest {
  const last = [...request.messages].reverse().find((message) => message.role === "user");
  const content = last?.content ?? "";
  return {
    ...request,
    instructions: request.instructions.slice(0, 2_000),
    memory: "",
    messages: [
      {
        role: "user",
        content:
          content.length > KEPT_PROMPT
            ? `${content.slice(0, KEPT_PROMPT)}\n…[cắt bớt ${content.length - KEPT_PROMPT} ký tự]`
            : content,
      },
    ],
  };
}

/** Run-time budget that can pause (approval waits do not burn the job's timeout). */
class Budget {
  private started: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  expired = false;
  private readonly limitMs: number;
  usedMs: number;
  private readonly onExpire: () => void;
  constructor(limitMs: number, usedMs: number, onExpire: () => void) {
    this.limitMs = limitMs;
    this.usedMs = usedMs;
    this.onExpire = onExpire;
  }
  resume() {
    if (this.started !== null || this.expired) return;
    this.started = Date.now();
    const left = Math.max(0, this.limitMs - this.usedMs);
    this.timer = setTimeout(() => {
      this.pause();
      this.expired = true;
      this.onExpire();
    }, left);
    // the server is kept alive by its listener; a job budget alone must not be
    (this.timer as { unref?: () => void }).unref?.();
  }
  pause() {
    if (this.started === null) return;
    this.usedMs += Date.now() - this.started;
    this.started = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  get used() {
    return this.usedMs + (this.started === null ? 0 : Date.now() - this.started);
  }
}

type Live = {
  controller: AbortController;
  budget: Budget;
  pending: Set<string>;
  flush: ReturnType<typeof setTimeout> | null;
};

function newJobId() {
  return `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function titleFor(request: ChatRequest) {
  const last =
    [...request.messages].reverse().find((message) => message.role === "user")?.content ?? "";
  const line = last
    .replace(/\[Đính kèm[^\]]*\][\s\S]*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  return (line || "Việc nền").slice(0, 80);
}

export class JobRunner {
  readonly approvals: Approvals;
  private readonly live = new Map<string, Live>();
  private readonly opts: Required<Omit<RunnerOptions, "onFinish" | "onWaiting" | "onApprovalSettled">> &
    Pick<RunnerOptions, "onFinish" | "onWaiting" | "onApprovalSettled">;
  private idleWaiters: (() => void)[] = [];
  private lastCreated = 0;

  constructor(options: RunnerOptions) {
    this.opts = {
      concurrency: 2,
      approvalTtlMs: 24 * 3_600_000,
      maxAttempts: 2,
      recovery: "requeue",
      enabled: () => true,
      now: () => Date.now(),
      flushMs: 500,
      abortGraceMs: 30_000,
      ...options,
    };
    for (const job of this.opts.db.listJobs())
      this.lastCreated = Math.max(this.lastCreated, job.createdAt);
    this.approvals = createApprovals(this.opts.approvalTtlMs);
  }

  get db() {
    return this.opts.db;
  }

  enabled() {
    return this.opts.enabled();
  }

  /** After a restart nothing is really running: requeue (bounded) or fail, and expire stale approvals. */
  recover() {
    const now = this.opts.now();
    let requeued = 0;
    let failed = 0;
    let cancelled = 0;
    for (const job of this.opts.db.listJobs()) {
      if (job.delivered === false && !isActive(job.status)) {
        // Finished right before a crash, before its inbox entry was written.
        this.deliver(job);
        continue;
      }
      if (job.status !== "running" && job.status !== "waiting_approval") continue;
      job.approvals = job.approvals.map((item) =>
        item.state === "pending" ? { ...item, state: "expired" } : item,
      );
      job.statusText = undefined;
      if (job.cancelRequested) {
        this.finalState(job, "cancelled", now);
        cancelled += 1;
      } else if (this.opts.recovery === "requeue" && job.attempts < this.opts.maxAttempts) {
        job.status = "queued";
        job.text = "";
        job.steps = [];
        job.citations = [];
        job.usedMs = 0;
        job.notices = [
          ...job.notices,
          `Máy chủ khởi động lại giữa chừng. Chạy lại từ đầu (lần ${job.attempts + 1}).`,
        ].slice(-MAX_NOTICES);
        job.updatedAt = now;
        requeued += 1;
      } else {
        job.error = "Máy chủ khởi động lại khi việc đang chạy.";
        this.finalState(job, "failed", now);
        failed += 1;
      }
      this.opts.db.saveJob(job);
      if (!isActive(job.status)) this.deliver(job);
    }
    return { requeued, failed, cancelled };
  }

  enqueue(input: EnqueueInput): Job {
    if (!this.opts.enabled()) throw new JobsDisabledError();
    const now = this.opts.now();
    // Strictly increasing creation time keeps FIFO order stable across reloads.
    const createdAt = Math.max(now, this.lastCreated + 1);
    const job: Job = {
      id: newJobId(),
      title: (input.title?.trim() || titleFor(input.request)).slice(0, 80),
      kind: input.kind ?? "agent",
      routineId: input.routineId,
      scheduledFor: input.scheduledFor,
      catchUp: input.catchUp,
      manual: input.manual || undefined,
      origin: input.origin,
      initiator: input.initiator ?? initiatorFor(input),
      status: "queued",
      request: input.request,
      maxSteps: input.maxSteps,
      timeoutMs: input.timeoutMs,
      createdAt,
      updatedAt: now,
      usedMs: 0,
      attempts: 0,
      text: "",
      steps: [],
      approvals: [],
      notices: [],
      citations: [],
    };
    this.opts.db.saveJob(job);
    this.lastCreated = createdAt;
    this.pump();
    return job;
  }

  hasActive(routineId: string) {
    return this.opts.db
      .listJobs()
      .some((job) => job.routineId === routineId && isActive(job.status));
  }

  running() {
    return this.live.size;
  }

  cancel(id: string): boolean {
    const job = this.opts.db.getJob(id);
    if (!job || !isActive(job.status)) return false;
    const live = this.live.get(id);
    if (!live) {
      this.finalState(job, "cancelled", this.opts.now());
      this.opts.db.saveJob(job);
      this.deliver(job);
      this.notifyIdle();
      return true;
    }
    if (job.cancelRequested) return true; // double cancel: already on its way out
    job.cancelRequested = true;
    job.statusText = "Đang hủy";
    this.opts.db.saveJob(job);
    live.controller.abort();
    return true;
  }

  /** Answer a job's pending write approval (same ids the UI card shows). */
  decide(approvalId: string, approve: boolean) {
    return this.approvals.decide(approvalId, approve);
  }

  /** Start queued jobs up to the concurrency limit (oldest first). */
  pump() {
    if (!this.opts.enabled()) return;
    const queued = this.opts.db
      .listJobs()
      .filter((job) => job.status === "queued" && !this.live.has(job.id))
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const job of queued) {
      if (this.live.size >= Math.max(1, this.opts.concurrency)) break;
      this.start(job);
    }
    this.notifyIdle();
  }

  /** Resolves once nothing is running or startable (tests, shutdown). */
  idle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private isIdle() {
    if (this.live.size) return false;
    if (!this.opts.enabled()) return true;
    return !this.opts.db.listJobs().some((job) => job.status === "queued");
  }

  private notifyIdle() {
    if (!this.isIdle()) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  private finalState(job: Job, status: JobStatus, now: number) {
    job.status = status;
    job.finishedAt = now;
    job.updatedAt = now;
    job.statusText = undefined;
    job.request = compactRequest(job.request);
    job.delivered = false;
  }

  /** Inbox delivery for a job in a final state; marked delivered only once it went through. */
  private deliver(job: Job) {
    try {
      this.opts.onFinish?.(job);
      job.delivered = true;
      this.opts.db.saveJob(job);
    } catch (error) {
      console.error(
        "[sable-jobs] inbox delivery failed:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  private start(job: Job) {
    const controller = new AbortController();
    const budget = new Budget(job.timeoutMs, job.usedMs, () => controller.abort());
    const live: Live = { controller, budget, pending: new Set(), flush: null };
    this.live.set(job.id, live);
    const now = this.opts.now();
    job.status = "running";
    job.startedAt ??= now;
    job.attempts += 1;
    job.updatedAt = now;
    job.error = undefined;
    this.opts.db.saveJob(job);
    budget.resume();

    const save = (soon: boolean) => {
      job.usedMs = budget.used;
      job.updatedAt = this.opts.now();
      if (!soon) {
        if (live.flush) clearTimeout(live.flush);
        live.flush = null;
        this.opts.db.saveJob(job);
        return;
      }
      live.flush ??= setTimeout(() => {
        live.flush = null;
        if (this.live.get(job.id) === live) this.opts.db.saveJob(job);
      }, this.opts.flushMs);
    };

    const emit = (event: ClientEvent) => {
      if (controller.signal.aborted && event.event !== "approval") return;
      switch (event.event) {
        case "delta":
          if (job.text.length < MAX_TEXT)
            job.text = (job.text + event.data.text).slice(0, MAX_TEXT);
          save(true);
          return;
        case "status":
          job.statusText = event.data.text;
          save(true);
          return;
        case "step":
          if (
            job.steps.length < MAX_STEPS_KEPT ||
            job.steps.some((item) => item.id === event.data.id)
          )
            job.steps = mergeTrace(job.steps, event.data);
          save(true);
          return;
        case "notice":
          job.notices = [...job.notices, event.data.text].slice(-MAX_NOTICES);
          save(false);
          return;
        case "citation":
          if (!job.citations.includes(event.data.url))
            job.citations = [...job.citations, event.data.url].slice(0, 40);
          save(true);
          return;
        case "approval": {
          const data = event.data;
          const existing = job.approvals.find((item) => item.id === data.id);
          const next: JobApproval = {
            id: data.id,
            tool: data.tool,
            summary: data.summary,
            preview: data.preview ?? existing?.preview,
            state: data.state,
            expiresAt:
              data.state === "pending"
                ? this.opts.now() + this.opts.approvalTtlMs
                : existing?.expiresAt,
          };
          job.approvals = existing
            ? job.approvals.map((item) => (item.id === data.id ? next : item))
            : [...job.approvals, next];
          if (data.state === "pending") {
            live.pending.add(data.id);
            budget.pause();
            if (!controller.signal.aborted) job.status = "waiting_approval";
            save(false);
            this.opts.onWaiting?.(job, next);
          } else {
            live.pending.delete(data.id);
            if (!live.pending.size && !controller.signal.aborted) {
              job.status = "running";
              budget.resume();
            }
            save(false);
            try {
              this.opts.onApprovalSettled?.(job, next);
            } catch (error) {
              console.warn("[sable-jobs] could not settle approval in inbox:", (error as Error).message);
            }
          }
          return;
        }
        default:
          return;
      }
    };

    const io: JobIO = {
      signal: controller.signal,
      emit,
      approve: (ask) => this.approvals.request(ask, emit, controller.signal),
    };

    void (async () => {
      let error: unknown = null;
      let stopped: "max_steps" | undefined;
      let graceTimer: ReturnType<typeof setTimeout> | null = null;
      // An exec that ignores the abort must not keep the job (and a slot) forever.
      const abandoned = new Promise<"abandoned">((resolve) => {
        const arm = () => {
          graceTimer = setTimeout(() => resolve("abandoned"), this.opts.abortGraceMs);
          (graceTimer as { unref?: () => void }).unref?.();
        };
        if (controller.signal.aborted) arm();
        else controller.signal.addEventListener("abort", arm, { once: true });
      });
      try {
        const result = await Promise.race([this.opts.exec(job, io), abandoned]);
        if (result === "abandoned") error = new Error("Việc không dừng kịp sau khi hủy hoặc quá giờ.");
        else stopped = result ? result.stopped : undefined;
      } catch (caught) {
        error = caught;
      }
      if (graceTimer) clearTimeout(graceTimer);
      budget.pause();
      if (live.flush) clearTimeout(live.flush);
      this.live.delete(job.id);
      const now = this.opts.now();
      job.usedMs = budget.used;
      // A write still pending when the job ended (cancel/timeout) was never approved.
      job.approvals = job.approvals.map((item) =>
        item.state === "pending" ? { ...item, state: "rejected" } : item,
      );
      if (job.cancelRequested) {
        this.finalState(job, "cancelled", now);
      } else if (budget.expired) {
        job.error = `Quá thời gian chạy (${Math.round(job.timeoutMs / 60_000) || 1} phút) nên đã dừng.`;
        this.finalState(job, "failed", now);
      } else if (error) {
        job.error =
          (error instanceof Error ? error.message : String(error)).slice(0, 400) || "Lỗi không rõ.";
        this.finalState(job, "failed", now);
      } else {
        job.stopped = stopped;
        if (!job.text.trim()) job.text = "";
        this.finalState(job, "done", now);
      }
      try {
        this.opts.db.saveJob(job);
      } catch (saveError) {
        console.error(
          "[sable-jobs] could not save finished job:",
          saveError instanceof Error ? saveError.message : saveError,
        );
      }
      this.deliver(job); // never throws: delivery must not break the queue
      try {
        this.opts.db.prune();
      } catch {
        /* retried after the next job */
      }
      this.pump();
    })();
  }
}
