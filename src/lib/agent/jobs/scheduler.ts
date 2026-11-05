/**
 * Routine scheduler: a tick (every 30 s) applies `planDue` to each routine.
 * On startup or after the box wakes from sleep a routine runs at most one
 * catch-up, never a burst, and never while its previous run is still active.
 */
import { MAX_INSTRUCTIONS, MAX_MEMORY } from "../assemble.ts";
import { isEffort, isModel } from "../harness.ts";
import type { ChatRequest } from "../types.ts";
import type { JobDb } from "./db.ts";
import type { EnqueueInput, JobRunner } from "./runner.ts";
import { DEFAULT_TZ, nextRun, planDue, validateSchedule } from "./schedule.ts";
import type { Job, Routine, RoutineRun, Schedule } from "./types.ts";
import {
  FIRE_MIN_GAP_MS,
  MAX_EVENT_TEXT,
  type CheckResult,
  cleanWatch,
  evaluateCheck,
  eventPrompt,
  newSecret,
  verifySecret,
  watchDue,
} from "./triggers.ts";

export const MAX_ROUTINES = 50;
export const MAX_HISTORY = 30;
export const MAX_PROMPT = 8_000;

export type SchedulerOptions = {
  db: JobDb;
  runner: JobRunner;
  /** SABLE_ROUTINES kill switch. */
  enabled?: () => boolean;
  now?: () => number;
  graceMs?: number;
  /** Max lateness for the one catch-up run; 0 = never catch up. */
  catchUpMs?: number;
  tickMs?: number;
  jobTimeoutMs: number;
  maxStepsCap: number;
  /** Event triggers (webhook + URL watch); SABLE_TRIGGERS=0 turns them off. */
  triggersOn?: () => boolean;
  /** Fetch a watched URL as text (must go through the http_fetch SSRF guards). */
  watchFetch?: (url: string, signal: AbortSignal) => Promise<CheckResult>;
  watchTickMs?: number;
};

export type RoutineInput = {
  name: string;
  prompt: string;
  schedule: Schedule;
  tz?: string;
  enabled?: boolean;
  catchUp?: boolean;
  model: string;
  effort?: string;
  presetName?: string;
  instructions?: string;
  memory?: string;
  tools?: Partial<ChatRequest["tools"]>;
  maxSteps?: number;
};

/** Expected refusal (limit, busy, kill switch): the API answers 409 with the message. */
export class RoutineRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoutineRefusal";
  }
}

function newId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function asSchedule(raw: unknown): Schedule | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as { kind?: unknown; expr?: unknown; minutes?: unknown };
  if (value.kind === "cron" && typeof value.expr === "string")
    return { kind: "cron", expr: value.expr.trim().replace(/\s+/g, " ").slice(0, 120) };
  if (value.kind === "interval" && typeof value.minutes === "number" && Number.isInteger(value.minutes))
    return { kind: "interval", minutes: value.minutes };
  return null;
}

/** Validate untrusted API input into a full routine draft (no id/timestamps). */
export function parseRoutineInput(
  raw: unknown,
  maxStepsCap: number,
  now = Date.now(),
): { ok: true; value: RoutineInput } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Thiếu nội dung." };
  const body = raw as Record<string, unknown>;
  // Wrong types are refused, not coerced ("false" must not mean enabled).
  for (const key of ["enabled", "catchUp"] as const)
    if (body[key] !== undefined && typeof body[key] !== "boolean")
      return { ok: false, error: `Trường ${key} phải là true/false.` };
  for (const key of ["name", "prompt", "tz", "effort", "presetName", "instructions", "memory"] as const)
    if (body[key] !== undefined && body[key] !== null && typeof body[key] !== "string")
      return { ok: false, error: `Trường ${key} phải là chữ.` };
  if (body.maxSteps !== undefined && (typeof body.maxSteps !== "number" || !Number.isFinite(body.maxSteps)))
    return { ok: false, error: "Số bước không hợp lệ." };
  if (body.tools !== undefined) {
    if (!body.tools || typeof body.tools !== "object" || Array.isArray(body.tools))
      return { ok: false, error: "Danh sách công cụ không hợp lệ." };
    for (const value of Object.values(body.tools as Record<string, unknown>))
      if (typeof value !== "boolean") return { ok: false, error: "Công cụ phải bật/tắt bằng true/false." };
  }
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!name) return { ok: false, error: "Đặt tên cho lịch chạy." };
  if (name.length > 80) return { ok: false, error: "Tên tối đa 80 ký tự." };
  if (!prompt) return { ok: false, error: "Viết việc cần làm." };
  // A routine's prompt is never cut silently: the run would do something else.
  if (prompt.length > MAX_PROMPT) return { ok: false, error: `Việc cần làm tối đa ${MAX_PROMPT} ký tự.` };
  if (typeof body.instructions === "string" && body.instructions.trim().length > MAX_INSTRUCTIONS)
    return { ok: false, error: `Hướng dẫn tối đa ${MAX_INSTRUCTIONS} ký tự.` };
  if (typeof body.memory === "string" && body.memory.trim().length > MAX_MEMORY)
    return { ok: false, error: `Ghi nhớ tối đa ${MAX_MEMORY} ký tự.` };
  const schedule = asSchedule(body.schedule);
  if (!schedule) return { ok: false, error: "Lịch không hợp lệ." };
  const tz = typeof body.tz === "string" && body.tz.trim() ? body.tz.trim().slice(0, 64) : DEFAULT_TZ;
  const problem = validateSchedule(schedule, tz, now);
  if (problem) return { ok: false, error: problem };
  if (!isModel(body.model)) return { ok: false, error: "Mô hình không hợp lệ." };
  if (typeof body.effort === "string" && !isEffort(body.effort))
    return { ok: false, error: "Mức suy nghĩ không hợp lệ." };
  const effort = typeof body.effort === "string" ? body.effort : "high";
  const tools = (body.tools && typeof body.tools === "object" ? body.tools : {}) as Record<
    string,
    unknown
  >;
  const steps =
    typeof body.maxSteps === "number" && Number.isFinite(body.maxSteps)
      ? Math.round(body.maxSteps)
      : maxStepsCap;
  return {
    ok: true,
    value: {
      name,
      prompt,
      schedule,
      tz,
      enabled: body.enabled !== false,
      catchUp: body.catchUp !== false,
      model: body.model,
      effort,
      presetName: typeof body.presetName === "string" ? body.presetName.slice(0, 60) : undefined,
      instructions: typeof body.instructions === "string" ? body.instructions.trim() : "",
      memory: typeof body.memory === "string" ? body.memory.trim() : "",
      tools: {
        web: Boolean(tools.web),
        x: Boolean(tools.x),
        code: Boolean(tools.code),
        image: false,
        files: Boolean(tools.files),
        fetch: Boolean(tools.fetch),
        shell: Boolean(tools.shell),
      },
      maxSteps: Math.min(maxStepsCap, Math.max(1, steps)),
    },
  };
}

export function requestFor(routine: Routine): ChatRequest {
  return {
    model: routine.model,
    effort: routine.effort,
    instructions: routine.instructions,
    memory: routine.memory,
    messages: [{ role: "user", content: routine.prompt }],
    tools: routine.tools,
  };
}

/** Trigger failure with an HTTP status (401 bad secret, 404, 409 off/busy, 429 too soon). */
export class TriggerError extends Error {
  readonly status: 401 | 404 | 409 | 422 | 429;
  constructor(status: 401 | 404 | 409 | 422 | 429, message: string) {
    super(message);
    this.status = status;
  }
}

export class RoutineScheduler {
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private watching = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly opts: Required<SchedulerOptions>;

  constructor(options: SchedulerOptions) {
    this.opts = {
      enabled: () => true,
      now: () => Date.now(),
      graceMs: 120_000,
      catchUpMs: 24 * 3_600_000,
      tickMs: 30_000,
      triggersOn: () => true,
      watchFetch: async () => ({ ok: false, error: "watch fetch not configured" }),
      watchTickMs: 60_000,
      ...options,
    };
  }

  enabled() {
    return this.opts.enabled();
  }

  list() {
    return this.opts.db.routines();
  }

  get(id: string) {
    return this.list().find((item) => item.id === id);
  }

  start() {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.opts.tickMs);
    (this.timer as { unref?: () => void }).unref?.();
    this.watchTimer = setInterval(() => void this.checkWatches(), this.opts.watchTickMs);
    (this.watchTimer as { unref?: () => void }).unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.timer = null;
    this.watchTimer = null;
  }

  private save(next: Routine[]) {
    this.opts.db.saveRoutines(next);
  }

  private patch(id: string, change: (routine: Routine) => Routine) {
    let found: Routine | undefined;
    this.save(
      this.list().map((item) => {
        if (item.id !== id) return item;
        found = change(item);
        return found;
      }),
    );
    return found;
  }

  private enqueueFor(routine: Routine, scheduledFor: number, catchUp: boolean, manual = false, prompt?: string): Job {
    const request = requestFor(routine);
    if (prompt) request.messages = [{ role: "user", content: prompt }];
    const input: EnqueueInput = {
      kind: "routine",
      title: routine.name,
      routineId: routine.id,
      scheduledFor,
      catchUp,
      manual,
      request,
      maxSteps: Math.min(this.opts.maxStepsCap, routine.maxSteps),
      timeoutMs: this.opts.jobTimeoutMs,
    };
    return this.opts.runner.enqueue(input);
  }

  /** Apply due plans. Returns the jobs started this tick. */
  tick(): Job[] {
    if (!this.opts.enabled() || !this.opts.runner.enabled()) return [];
    const now = this.opts.now();
    const started: Job[] = [];
    const next = this.list().map((original) => {
      // Clock set back before the interval anchor: re-anchor at now, or every slot
      // would be computed from a moment that has not happened yet.
      const routine =
        original.anchorAt > now && original.schedule.kind === "interval"
          ? {
              ...original,
              anchorAt: now,
              nextRunAt: original.enabled ? nextRun(original.schedule, original.tz, now, now) : null,
            }
          : original;
      const plan = planDue(routine, now, {
        graceMs: this.opts.graceMs,
        catchUpMs: this.opts.catchUpMs,
        busy: this.opts.runner.hasActive(routine.id),
      });
      if (!plan.fire && !plan.skipped) {
        // Clock moved back: only the next slot changes.
        return plan.nextRunAt === routine.nextRunAt ? routine : { ...routine, nextRunAt: plan.nextRunAt };
      }
      const runs: RoutineRun[] = [];
      if (plan.fire && this.alreadyFired(routine.id, plan.fire.scheduledFor)) {
        // A job for this slot exists (e.g. the server stopped right after enqueuing it,
        // before nextRunAt was saved): advance without a duplicate run.
        return { ...routine, nextRunAt: plan.nextRunAt };
      }
      if (plan.fire) {
        try {
          const job = this.enqueueFor(routine, plan.fire.scheduledFor, plan.fire.catchUp);
          started.push(job);
          runs.push({
            id: newId("run"),
            at: now,
            scheduledFor: plan.fire.scheduledFor,
            outcome: "queued",
            catchUp: plan.fire.catchUp || undefined,
            jobId: job.id,
            note: plan.fire.catchUp
              ? plan.missed > 0
                ? `Chạy bù 1 lượt, bỏ qua ${plan.missed} lượt lỡ khác.`
                : "Chạy bù lượt bị lỡ."
              : undefined,
          });
        } catch (error) {
          runs.push({
            id: newId("run"),
            at: now,
            scheduledFor: plan.fire.scheduledFor,
            outcome: "error",
            note: error instanceof Error ? error.message : String(error),
          });
        }
      } else if (plan.skipped === "busy") {
        runs.push({
          id: newId("run"),
          at: now,
          scheduledFor: routine.nextRunAt ?? now,
          outcome: "busy",
          note: "Lượt trước chưa xong nên bỏ qua lượt này.",
        });
      } else {
        runs.push({
          id: newId("run"),
          at: now,
          scheduledFor: routine.nextRunAt ?? now,
          outcome: "missed",
          note: `Bỏ lỡ ${plan.missed} lượt (máy ngủ hoặc tắt), không chạy bù.`,
        });
      }
      return {
        ...routine,
        nextRunAt: plan.nextRunAt,
        lastRunAt: plan.fire ? now : routine.lastRunAt,
        history: [...runs, ...routine.history].slice(0, MAX_HISTORY),
      };
    });
    if (next.some((item, index) => item !== this.list()[index])) this.save(next);
    return started;
  }

  /** A scheduled (not manual) job of this routine already exists for exactly this slot. */
  private alreadyFired(routineId: string, slot: number) {
    return this.opts.db
      .listJobs()
      .some(
        (job) =>
          job.routineId === routineId &&
          !job.manual &&
          typeof job.scheduledFor === "number" &&
          job.scheduledFor === slot,
      );
  }

  create(input: RoutineInput): Routine {
    if (this.list().length >= MAX_ROUTINES) throw new RoutineRefusal(`Tối đa ${MAX_ROUTINES} lịch chạy.`);
    const now = this.opts.now();
    const routine: Routine = {
      id: newId("rtn"),
      name: input.name,
      prompt: input.prompt,
      schedule: input.schedule,
      tz: input.tz ?? DEFAULT_TZ,
      enabled: input.enabled !== false,
      catchUp: input.catchUp !== false,
      model: input.model,
      effort: (input.effort as Routine["effort"]) ?? "high",
      presetName: input.presetName,
      instructions: input.instructions ?? "",
      memory: input.memory ?? "",
      tools: {
        web: false,
        x: false,
        code: false,
        image: false,
        files: false,
        fetch: false,
        shell: false,
        ...input.tools,
      },
      maxSteps: input.maxSteps ?? this.opts.maxStepsCap,
      createdAt: now,
      updatedAt: now,
      anchorAt: now,
      nextRunAt: null,
      history: [],
    };
    routine.nextRunAt = routine.enabled ? nextRun(routine.schedule, routine.tz, now, now) : null;
    this.save([...this.list(), routine]);
    return routine;
  }

  update(id: string, input: RoutineInput): Routine | undefined {
    const now = this.opts.now();
    return this.patch(id, (routine) => {
      const timing =
        JSON.stringify(routine.schedule) !== JSON.stringify(input.schedule) ||
        routine.tz !== (input.tz ?? DEFAULT_TZ);
      const enabled = input.enabled !== false;
      const next: Routine = {
        ...routine,
        name: input.name,
        prompt: input.prompt,
        schedule: input.schedule,
        tz: input.tz ?? DEFAULT_TZ,
        enabled,
        catchUp: input.catchUp !== false,
        model: input.model,
        effort: (input.effort as Routine["effort"]) ?? routine.effort,
        presetName: input.presetName,
        instructions: input.instructions ?? "",
        memory: input.memory ?? "",
        tools: { ...routine.tools, ...input.tools, image: false },
        maxSteps: input.maxSteps ?? routine.maxSteps,
        updatedAt: now,
        // New timing anchors at now; resuming a paused routine never back-fills the pause.
        anchorAt: timing ? now : routine.anchorAt,
      };
      if (!enabled) next.nextRunAt = null;
      else if (timing || !routine.enabled || routine.nextRunAt === null)
        next.nextRunAt = nextRun(next.schedule, next.tz, now, next.anchorAt);
      return next;
    });
  }

  setEnabled(id: string, enabled: boolean) {
    const now = this.opts.now();
    return this.patch(id, (routine) => ({
      ...routine,
      enabled,
      updatedAt: now,
      nextRunAt: enabled
        ? routine.enabled && routine.nextRunAt !== null
          ? routine.nextRunAt
          : nextRun(routine.schedule, routine.tz, now, routine.anchorAt)
        : null,
    }));
  }

  remove(id: string) {
    const before = this.list().length;
    this.save(this.list().filter((item) => item.id !== id));
    return this.list().length < before;
  }

  /** Manual run; refuses while a previous run is still active. Schedule is unchanged. */
  runNow(id: string): Job {
    if (!this.opts.enabled() || !this.opts.runner.enabled())
      throw new RoutineRefusal("Lịch chạy đang tắt trên máy chủ (SABLE_ROUTINES=0 hoặc SABLE_JOBS=0).");
    const routine = this.get(id);
    if (!routine) throw new RoutineRefusal("Không tìm thấy lịch chạy.");
    if (this.opts.runner.hasActive(id)) throw new RoutineRefusal("Lượt trước của lịch này chưa xong.");
    const now = this.opts.now();
    const job = this.enqueueFor(routine, now, false, true);
    this.patch(id, (item) => ({
      ...item,
      lastRunAt: now,
      history: [
        {
          id: newId("run"),
          at: now,
          scheduledFor: now,
          outcome: "manual" as const,
          jobId: job.id,
          note: "Chạy ngay",
        },
        ...item.history,
      ].slice(0, MAX_HISTORY),
    }));
    return job;
  }

  triggersEnabled() {
    return this.opts.triggersOn() && this.opts.enabled() && this.opts.runner.enabled();
  }

  /** Create or rotate the webhook secret; the plain secret is returned only here. */
  setWebhook(id: string, on: boolean): { secret?: string } {
    if (!this.opts.triggersOn()) throw new TriggerError(409, "Trigger sự kiện đang tắt (SABLE_TRIGGERS=0).");
    if (!this.get(id)) throw new TriggerError(404, "Không tìm thấy lịch chạy.");
    const now = this.opts.now();
    const fresh = on ? newSecret() : null;
    this.patch(id, (r) => ({
      ...r,
      updatedAt: now,
      trigger: { ...r.trigger, webhook: fresh ? { hash: fresh.hash, createdAt: now } : undefined },
    }));
    return fresh ? { secret: fresh.secret } : {};
  }

  setWatch(id: string, input: unknown | null) {
    if (!this.opts.triggersOn()) throw new TriggerError(409, "Trigger sự kiện đang tắt (SABLE_TRIGGERS=0).");
    if (!this.get(id)) throw new TriggerError(404, "Không tìm thấy lịch chạy.");
    const now = this.opts.now();
    let watch: ReturnType<typeof cleanWatch> | null = null;
    if (input !== null) {
      watch = cleanWatch(input, now);
      if (!watch.ok) throw new TriggerError(422, watch.error);
    }
    return this.patch(id, (r) => {
      const prev = r.trigger?.watch;
      // Same URL: keep the baseline so editing the interval does not re-baseline.
      const value =
        watch && watch.ok
          ? prev && prev.url === watch.value.url
            ? { ...prev, everyMin: watch.value.everyMin, nextCheckAt: now }
            : watch.value
          : undefined;
      return { ...r, updatedAt: now, trigger: { ...r.trigger, watch: value } };
    });
  }

  /** Start a run for an event; refuses when off, paused or busy. */
  private fireEvent(routine: Routine, source: "webhook" | "watch", text: string, url?: string): Job {
    if (!this.triggersEnabled()) throw new TriggerError(409, "Trigger sự kiện đang tắt trên máy chủ.");
    if (!routine.enabled) throw new TriggerError(409, "Lịch chạy đang tạm dừng.");
    if (this.opts.runner.hasActive(routine.id)) throw new TriggerError(409, "Lượt trước của lịch này chưa xong.");
    const now = this.opts.now();
    const job = this.enqueueFor(routine, now, false, true, eventPrompt(routine.prompt, source, text, url));
    this.patch(routine.id, (item) => ({
      ...item,
      lastRunAt: now,
      trigger:
        source === "webhook" && item.trigger?.webhook
          ? { ...item.trigger, webhook: { ...item.trigger.webhook, lastFiredAt: now } }
          : item.trigger,
      history: [
        {
          id: newId("run"),
          at: now,
          scheduledFor: now,
          outcome: source,
          jobId: job.id,
          note: source === "webhook" ? "Webhook" : "Trang theo dõi thay đổi",
        },
        ...item.history,
      ].slice(0, MAX_HISTORY),
    }));
    return job;
  }

  /** Webhook entry: constant-time secret check first, same answer for unknown ids. */
  fireWebhook(id: string, secret: unknown, payload: string): Job {
    const routine = this.get(id);
    const ok = verifySecret(secret, routine?.trigger?.webhook?.hash);
    if (!this.opts.triggersOn()) throw new TriggerError(409, "Trigger sự kiện đang tắt (SABLE_TRIGGERS=0).");
    if (!routine || !ok) throw new TriggerError(401, "Sai secret hoặc lịch chạy không có webhook.");
    const last = routine.trigger?.webhook?.lastFiredAt ?? 0;
    if (this.opts.now() - last < FIRE_MIN_GAP_MS) throw new TriggerError(429, "Gọi quá nhanh, thử lại sau ít giây.");
    return this.fireEvent(routine, "webhook", payload.slice(0, MAX_EVENT_TEXT));
  }

  /** One pass over due watches (sequential; overlapping passes are skipped). */
  async checkWatches(): Promise<number> {
    if (this.watching || !this.triggersEnabled()) return 0;
    this.watching = true;
    let fired = 0;
    try {
      for (const routine of this.list()) {
        const watch = routine.trigger?.watch;
        const now = this.opts.now();
        if (!routine.enabled || !watch || !watchDue(watch, now)) continue;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20_000);
        let res: CheckResult;
        try {
          res = await this.opts.watchFetch(watch.url, controller.signal);
        } catch (error) {
          res = { ok: false, error: error instanceof Error ? error.message : String(error) };
        } finally {
          clearTimeout(timer);
        }
        const verdict = evaluateCheck(watch, res, this.opts.now());
        let didFire = false;
        if (verdict.fire) {
          const current = this.get(routine.id);
          try {
            if (current) {
              this.fireEvent(current, "watch", verdict.fire, watch.url);
              didFire = true;
              fired += 1;
            }
          } catch {
            // Busy / paused: the change is kept pending (old hash stays) and retried.
          }
        }
        const next = verdict.commit(didFire);
        this.patch(routine.id, (item) =>
          item.trigger?.watch?.url === watch.url ? { ...item, trigger: { ...item.trigger, watch: next } } : item,
        );
      }
    } finally {
      this.watching = false;
    }
    return fired;
  }
}
