/**
 * Routine schedules: cron (5 fields, presets) or a fixed interval ≥ 5 min, on
 * a timezone wall clock (default Asia/Saigon, UTC+7, no DST). Also the pure
 * "what is due now" planner that the scheduler tick applies — at most one
 * run per routine per tick, at most one catch-up after a missed slot.
 */
import { isTimeZone, minGap, nextCron, parseCron } from "./cron.ts";
import type { Routine, Schedule } from "./types.ts";

export const DEFAULT_TZ = "Asia/Saigon";
export const MIN_INTERVAL_MIN = 5;
export const MAX_INTERVAL_MIN = 7 * 24 * 60;
const MINUTE = 60_000;

export function validateSchedule(schedule: Schedule, tz: string, now = Date.now()): string | null {
  if (!isTimeZone(tz)) return `Múi giờ không hợp lệ: ${tz}`;
  if (schedule.kind === "interval") {
    if (!Number.isInteger(schedule.minutes) || schedule.minutes < MIN_INTERVAL_MIN)
      return `Khoảng lặp tối thiểu ${MIN_INTERVAL_MIN} phút.`;
    if (schedule.minutes > MAX_INTERVAL_MIN)
      return "Khoảng lặp tối đa 7 ngày. Dùng cron cho lịch thưa hơn.";
    return null;
  }
  const parsed = parseCron(schedule.expr);
  if (!parsed.ok) return parsed.error;
  if (nextCron(parsed.spec, now, tz) === null) return "Cron này không bao giờ chạy.";
  if (minGap(parsed.spec, now, tz) < MIN_INTERVAL_MIN * MINUTE)
    return `Lịch chạy dày hơn ${MIN_INTERVAL_MIN} phút một lần. Hãy giãn ra.`;
  return null;
}

/** Next slot strictly after `afterMs`. Interval slots are anchored at `anchorMs`. */
export function nextRun(
  schedule: Schedule,
  tz: string,
  afterMs: number,
  anchorMs = afterMs,
): number | null {
  if (schedule.kind === "interval") {
    const step = Math.max(MIN_INTERVAL_MIN, schedule.minutes) * MINUTE;
    if (afterMs < anchorMs) return anchorMs + step;
    return anchorMs + (Math.floor((afterMs - anchorMs) / step) + 1) * step;
  }
  const parsed = parseCron(schedule.expr);
  return parsed.ok ? nextCron(parsed.spec, afterMs, tz) : null;
}

export function describeSchedule(schedule: Schedule): string {
  if (schedule.kind === "interval") {
    const m = schedule.minutes;
    if (m % 1440 === 0) return `Mỗi ${m / 1440} ngày`;
    if (m % 60 === 0) return m === 60 ? "Mỗi giờ" : `Mỗi ${m / 60} giờ`;
    return `Mỗi ${m} phút`;
  }
  const expr = schedule.expr.trim();
  const hourly = expr.match(/^(\d{1,2}) \* \* \* \*$/);
  if (expr === "@hourly" || hourly) return `Mỗi giờ, phút ${hourly ? hourly[1] : "0"}`;
  const daily = expr.match(/^(\d{1,2}) (\d{1,2}) \* \* \*$/);
  if (expr === "@daily" || daily)
    return `Mỗi ngày lúc ${pad(daily ? daily[2] : "0")}:${pad(daily ? daily[1] : "0")}`;
  const weekdays = expr.match(/^(\d{1,2}) (\d{1,2}) \* \* 1-5$/);
  if (weekdays) return `Thứ 2–6 lúc ${pad(weekdays[2])}:${pad(weekdays[1])}`;
  return `Cron ${expr}`;
}

function pad(value: string | undefined) {
  return (value ?? "0").padStart(2, "0");
}

export type DuePlan = {
  fire: { scheduledFor: number; catchUp: boolean } | null;
  skipped?: "missed" | "busy";
  /** New nextRunAt to store (unchanged when nothing was due). */
  nextRunAt: number | null;
  /** Slots passed over (the fired one excluded). */
  missed: number;
};

export type PlanOptions = {
  /** A slot this late is still "on time" (tick jitter). */
  graceMs: number;
  /** Max lateness for the single catch-up run; 0 disables catch-up globally. */
  catchUpMs: number;
  /** The routine already has a queued/running/waiting job. */
  busy: boolean;
};

/**
 * Decide what a routine does at `now`. Never more than one run: after a long
 * sleep it fires once (if catch-up allows) and jumps nextRunAt past `now`.
 */
export function planDue(
  routine: Pick<Routine, "enabled" | "nextRunAt" | "schedule" | "tz" | "catchUp" | "anchorAt">,
  now: number,
  options: PlanOptions,
): DuePlan {
  const due = routine.nextRunAt;
  if (!routine.enabled || due === null) return { fire: null, nextRunAt: due, missed: 0 };
  if (due > now) {
    // The wall clock jumped backwards (manual change, NTP fix, VM restore): the stored
    // slot may now be hours or days away. Re-plan from now instead of waiting it out.
    const expected = nextRun(routine.schedule, routine.tz, now, routine.anchorAt);
    if (expected !== null && expected < due) return { fire: null, nextRunAt: expected, missed: 0 };
    return { fire: null, nextRunAt: due, missed: 0 };
  }
  const next = nextRun(routine.schedule, routine.tz, now, routine.anchorAt);
  // Walk the passed slots: count them and keep the most recent one.
  let missed = 0;
  let latest = due;
  for (
    let slot: number | null = due;
    slot !== null && slot <= now && missed < 10_000;
    slot = nextRun(routine.schedule, routine.tz, slot, routine.anchorAt)
  ) {
    missed += 1;
    latest = slot;
  }
  if (options.busy) return { fire: null, skipped: "busy", nextRunAt: next, missed };
  // Only the first passed slot can be "on time"; anything else is a catch-up.
  if (missed === 1 && now - due <= options.graceMs)
    return { fire: { scheduledFor: due, catchUp: false }, nextRunAt: next, missed: 0 };
  if (routine.catchUp && options.catchUpMs > 0 && now - latest <= options.catchUpMs) {
    return { fire: { scheduledFor: latest, catchUp: true }, nextRunAt: next, missed: missed - 1 };
  }
  return { fire: null, skipped: "missed", nextRunAt: next, missed };
}
