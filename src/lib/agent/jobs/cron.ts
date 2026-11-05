/**
 * Minimal 5-field cron (minute hour day-of-month month day-of-week) evaluated
 * on the wall clock of an IANA timezone. Pure: no timers, no I/O.
 *
 * Supports `*`, numbers, ranges `a-b`, steps `* /n` and `a-b/n`, lists `a,b`,
 * month/day names (JAN, MON), 7 = Sunday, and @hourly/@daily/@weekly/@monthly/@yearly.
 * Day-of-month and day-of-week follow classic cron: when both are restricted,
 * either one matching is enough.
 */

export type CronSpec = {
  minute: ReadonlySet<number>;
  hour: ReadonlySet<number>;
  dom: ReadonlySet<number>;
  month: ReadonlySet<number>;
  dow: ReadonlySet<number>;
  domStar: boolean;
  dowStar: boolean;
};

export const CRON_ALIASES: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

type Field = { name: string; min: number; max: number; names?: string[]; nameBase?: number };
const FIELDS: Field[] = [
  { name: "phút", min: 0, max: 59 },
  { name: "giờ", min: 0, max: 23 },
  { name: "ngày", min: 1, max: 31 },
  { name: "tháng", min: 1, max: 12, names: MONTHS, nameBase: 1 },
  { name: "thứ", min: 0, max: 7, names: DAYS, nameBase: 0 },
];

function atom(raw: string, field: Field): number | null {
  const upper = raw.toUpperCase();
  if (field.names) {
    const index = field.names.indexOf(upper);
    if (index >= 0) return index + (field.nameBase ?? 0);
  }
  if (!/^\d{1,2}$/.test(raw)) return null;
  const value = Number(raw);
  return value >= field.min && value <= field.max ? value : null;
}

function parseField(
  text: string,
  field: Field,
): { ok: true; values: Set<number>; star: boolean } | { ok: false; error: string } {
  const values = new Set<number>();
  let star = false;
  for (const part of text.split(",")) {
    if (!part) return { ok: false, error: `trường ${field.name} có dấu phẩy thừa` };
    const [range, stepText, extra] = part.split("/");
    if (extra !== undefined)
      return { ok: false, error: `trường ${field.name} không hợp lệ: ${part}` };
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d{1,2}$/.test(stepText) || Number(stepText) < 1)
        return { ok: false, error: `bước ở trường ${field.name} không hợp lệ: ${part}` };
      step = Number(stepText);
    }
    let lo: number;
    let hi: number;
    if (range === "*") {
      lo = field.min;
      hi = field.max === 7 ? 6 : field.max;
      if (stepText === undefined) star = true;
    } else if (range.includes("-")) {
      const bounds = range.split("-");
      if (bounds.length !== 2)
        return { ok: false, error: `khoảng ở trường ${field.name} không hợp lệ: ${part}` };
      const [a, b] = bounds;
      const from = atom(a ?? "", field);
      const to = atom(b ?? "", field);
      if (from === null || to === null || from > to)
        return { ok: false, error: `khoảng ở trường ${field.name} không hợp lệ: ${part}` };
      lo = from;
      hi = to;
    } else {
      const one = atom(range, field);
      if (one === null)
        return { ok: false, error: `giá trị ở trường ${field.name} không hợp lệ: ${part}` };
      lo = one;
      hi = stepText === undefined ? one : field.max === 7 ? 6 : field.max;
    }
    for (let value = lo; value <= hi; value += step)
      values.add(field.max === 7 && value === 7 ? 0 : value);
  }
  return { ok: true, values, star };
}

export function parseCron(
  expression: string,
): { ok: true; spec: CronSpec } | { ok: false; error: string } {
  const trimmed = expression.trim().replace(/\s+/g, " ");
  const expanded = CRON_ALIASES[trimmed.toLowerCase()] ?? trimmed;
  const parts = expanded.split(" ");
  if (parts.length !== 5)
    return { ok: false, error: "Cron cần đúng 5 trường: phút giờ ngày tháng thứ." };
  const out: { values: Set<number>; star: boolean }[] = [];
  for (let index = 0; index < 5; index += 1) {
    const parsed = parseField(parts[index] ?? "", FIELDS[index] as Field);
    if (!parsed.ok) return { ok: false, error: `Cron: ${parsed.error}.` };
    out.push(parsed);
  }
  const [minute, hour, dom, month, dow] = out as [
    (typeof out)[0],
    (typeof out)[0],
    (typeof out)[0],
    (typeof out)[0],
    (typeof out)[0],
  ];
  return {
    ok: true,
    spec: {
      minute: minute.values,
      hour: hour.values,
      dom: dom.values,
      month: month.values,
      dow: dow.values,
      domStar: dom.star,
      dowStar: dow.star,
    },
  };
}

export function isTimeZone(tz: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string) {
  let found = formatters.get(tz);
  if (!found) {
    found = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(tz, found);
  }
  return found;
}

/** Wall-clock time in `tz` at `utcMs`, encoded as a UTC epoch (only its UTC fields matter). */
export function wallOf(utcMs: number, tz: string) {
  const parts: Record<string, number> = {};
  for (const part of formatter(tz).formatToParts(new Date(utcMs))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return Date.UTC(
    parts.year ?? 1970,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
  );
}

/** Offset of `tz` from UTC at `utcMs`, in ms (Asia/Saigon → +7h). */
export function offsetAt(utcMs: number, tz: string) {
  const floored = Math.floor(utcMs / 1000) * 1000;
  return wallOf(floored, tz) - floored;
}

/** Wall-clock (UTC-encoded) → real instant; null when that wall time does not exist (DST gap). */
export function utcOfWall(wallMs: number, tz: string): number | null {
  let guess = wallMs - offsetAt(wallMs, tz);
  guess = wallMs - offsetAt(guess, tz);
  return wallOf(guess, tz) === wallMs ? guess : null;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function matchesDay(spec: CronSpec, wall: Date) {
  const domOk = spec.dom.has(wall.getUTCDate());
  const dowOk = spec.dow.has(wall.getUTCDay());
  if (spec.domStar && spec.dowStar) return true;
  if (spec.domStar) return dowOk;
  if (spec.dowStar) return domOk;
  return domOk || dowOk;
}

/** First instant strictly after `afterMs` matching `spec` on `tz`'s wall clock; null if none within ~5 years. */
export function nextCron(spec: CronSpec, afterMs: number, tz: string): number | null {
  let wall = Math.floor(wallOf(afterMs, tz) / MINUTE) * MINUTE + MINUTE;
  const limit = wall + 5 * 366 * DAY;
  while (wall < limit) {
    const date = new Date(wall);
    if (!spec.month.has(date.getUTCMonth() + 1)) {
      wall = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
      continue;
    }
    if (!matchesDay(spec, date)) {
      wall = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
      continue;
    }
    if (!spec.hour.has(date.getUTCHours())) {
      wall = Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate(),
        date.getUTCHours() + 1,
      );
      continue;
    }
    if (!spec.minute.has(date.getUTCMinutes())) {
      wall += MINUTE;
      continue;
    }
    const utc = utcOfWall(wall, tz);
    if (utc !== null && utc > afterMs) return utc;
    wall += MINUTE;
  }
  return null;
}

/** Smallest gap (ms) between the next `count` runs; Infinity when it fires at most once. */
export function minGap(spec: CronSpec, fromMs: number, tz: string, count = 60) {
  let previous = nextCron(spec, fromMs, tz);
  let gap = Number.POSITIVE_INFINITY;
  for (let index = 0; previous !== null && index < count; index += 1) {
    const next = nextCron(spec, previous, tz);
    if (next === null) break;
    gap = Math.min(gap, next - previous);
    previous = next;
  }
  return gap;
}
