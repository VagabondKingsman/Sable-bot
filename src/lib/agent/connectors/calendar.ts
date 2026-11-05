/** W2b Google Calendar client (REST v3). Pure: calls go through an injected ApiCall. */
import { call, type ApiCall } from "./http.ts";

export type CalEvent = {
  id: string;
  calendarId: string;
  summary: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  description?: string;
  status?: string;
  htmlLink?: string;
  attendees?: number;
};
type RawEvent = {
  id: string;
  summary?: string;
  status?: string;
  location?: string;
  description?: string;
  htmlLink?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: unknown[];
};

const clip = (s: string | undefined, n: number) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function toEvent(e: RawEvent, calendarId: string): CalEvent {
  return {
    id: e.id,
    calendarId,
    summary: clip(e.summary, 200) ?? "(không tiêu đề)",
    start: e.start?.dateTime ?? e.start?.date ?? "",
    end: e.end?.dateTime ?? e.end?.date ?? "",
    allDay: Boolean(e.start?.date && !e.start?.dateTime),
    ...(e.location ? { location: clip(e.location, 200) } : {}),
    ...(e.description ? { description: clip(e.description, 1_000) } : {}),
    ...(e.status ? { status: e.status } : {}),
    ...(e.htmlLink ? { htmlLink: e.htmlLink } : {}),
    ...(Array.isArray(e.attendees) ? { attendees: e.attendees.length } : {}),
  };
}

/** Local-day bounds [start, end) as epoch ms for `now` in `tz`. */
export function dayBounds(now: Date, tz: string) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, Number(x.value)]));
  const minute = Math.floor(now.getTime() / 60_000) * 60_000;
  const offset = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - minute;
  const start = Date.UTC(p.year, p.month - 1, p.day) - offset;
  return { start, end: start + 86_400_000 };
}

export type EventInput = { summary?: string; start?: string; end?: string; description?: string; location?: string; allDay?: boolean };

const ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/;

/** Validate + map to the API body. All-day when both are YYYY-MM-DD. */
export function eventBody(e: EventInput, partial = false): Record<string, unknown> | string {
  const body: Record<string, unknown> = {};
  if (e.summary !== undefined) {
    if (!e.summary.trim() || e.summary.length > 300) return "summary: 1..300 ký tự";
    body.summary = e.summary.trim();
  } else if (!partial) return "thiếu summary";
  for (const k of ["start", "end"] as const) {
    const v = e[k];
    if (v === undefined) {
      if (!partial) return `thiếu ${k}`;
      continue;
    }
    if (!ISO.test(v)) return `${k} phải là ISO 8601 có múi giờ (vd 2026-11-06T09:00:00+07:00) hoặc YYYY-MM-DD`;
    body[k] = v.length === 10 ? { date: v } : { dateTime: v };
  }
  if (body.start && body.end) {
    const s = Date.parse(e.start!);
    const en = Date.parse(e.end!);
    if (!(en > s)) return "end phải sau start";
    if (en - s > 31 * 86_400_000) return "sự kiện tối đa 31 ngày";
  }
  if (e.description !== undefined) body.description = e.description.slice(0, 8_000);
  if (e.location !== undefined) body.location = e.location.slice(0, 300);
  if (partial && !Object.keys(body).length) return "không có gì để sửa";
  return body;
}

export type CalendarClient = ReturnType<typeof calendarClient>;

export function calendarClient(base: string, api: ApiCall) {
  const u = (p: string, q?: Record<string, string | number | boolean | undefined>) => {
    const url = new URL(p, base);
    for (const [k, v] of Object.entries(q ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    return url.toString();
  };
  const cal = (id: string) => `calendars/${encodeURIComponent(id || "primary")}`;
  return {
    async calendars() {
      const r = await call<{ items?: { id: string; summary?: string; primary?: boolean; accessRole?: string; timeZone?: string }[] }>("Calendar", api, u("users/me/calendarList"));
      return (r.items ?? []).map((c) => ({ id: c.id, summary: c.summary ?? c.id, primary: Boolean(c.primary), accessRole: c.accessRole, timeZone: c.timeZone }));
    },
    async events(q: { calendarId?: string; timeMin: string; timeMax: string; query?: string; max?: number }) {
      const r = await call<{ items?: RawEvent[] }>("Calendar", api, u(`${cal(q.calendarId ?? "primary")}/events`, { timeMin: q.timeMin, timeMax: q.timeMax, singleEvents: true, orderBy: "startTime", q: q.query, maxResults: Math.min(Math.max(q.max ?? 50, 1), 100) }));
      return (r.items ?? []).filter((e) => e.status !== "cancelled").map((e) => toEvent(e, q.calendarId ?? "primary"));
    },
    async freeBusy(q: { timeMin: string; timeMax: string; ids?: string[]; timeZone?: string }) {
      const r = await call<{ calendars?: Record<string, { busy?: { start: string; end: string }[]; errors?: unknown[] }> }>("Calendar", api, u("freeBusy"), {
        method: "POST",
        body: { timeMin: q.timeMin, timeMax: q.timeMax, ...(q.timeZone ? { timeZone: q.timeZone } : {}), items: (q.ids?.length ? q.ids : ["primary"]).slice(0, 20).map((id) => ({ id })) },
      });
      return Object.entries(r.calendars ?? {}).map(([id, v]) => ({ id, busy: v.busy ?? [], error: Boolean(v.errors?.length) }));
    },
    async create(calendarId: string, body: Record<string, unknown>) {
      return toEvent(await call<RawEvent>("Calendar", api, u(`${cal(calendarId)}/events`, { sendUpdates: "none" }), { method: "POST", body }), calendarId);
    },
    async update(calendarId: string, eventId: string, body: Record<string, unknown>) {
      return toEvent(await call<RawEvent>("Calendar", api, u(`${cal(calendarId)}/events/${encodeURIComponent(eventId)}`, { sendUpdates: "none" }), { method: "PATCH", body }), calendarId);
    },
    async remove(calendarId: string, eventId: string) {
      await call<unknown>("Calendar", api, u(`${cal(calendarId)}/events/${encodeURIComponent(eventId)}`, { sendUpdates: "none" }), { method: "DELETE" });
      return { deleted: eventId };
    },
  };
}
