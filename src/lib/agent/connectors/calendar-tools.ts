/** W2b Google Calendar agent tools. Reads are free; create/update/delete always need the owner's approval. */
import type { FunctionTool } from "../tools/types.ts";
import { eventBody, type CalEvent, type CalendarClient, type EventInput } from "./calendar.ts";
import { fence } from "./http.ts";

type Get = () => CalendarClient | null;
const NOT = "Google Calendar chưa kết nối (Cài đặt → Kết nối).";
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const line = (e: CalEvent) => `${e.id} · ${e.allDay ? `${e.start} (cả ngày)` : `${e.start} → ${e.end}`} · ${e.summary}${e.location ? ` @ ${e.location}` : ""}${e.attendees ? ` · ${e.attendees} người` : ""}`;
const ISO_HINT = "ISO 8601 with offset, e.g. 2026-11-06T09:00:00+07:00 (or YYYY-MM-DD for all-day)";

const eventProps = {
  calendar_id: { type: "string", description: "Default: primary" },
  summary: { type: "string" },
  start: { type: "string", description: ISO_HINT },
  end: { type: "string", description: ISO_HINT },
  description: { type: "string" },
  location: { type: "string" },
} as const;

type EvArgs = EventInput & { calendar_id?: string };

export function calendarTools(get: Get): FunctionTool<any>[] {
  const need = () => {
    const c = get();
    if (!c) throw new Error(NOT);
    return c;
  };
  const calendars: FunctionTool<Record<string, never>> = {
    kind: "function",
    name: "cal_calendars",
    description: "List the owner's Google calendars.",
    parameters: { type: "object", properties: {}, required: [] },
    risk: "read",
    timeoutMs: 20_000,
    maxOutput: 6_000,
    label: () => "cal_calendars",
    run: async () => ({ ok: true, output: (await need().calendars()).map((c) => `${c.id}${c.primary ? " (primary)" : ""}: ${c.summary} [${c.accessRole ?? "?"}]`).join("\n") || "(không có lịch)" }),
  };
  const events: FunctionTool<{ time_min: string; time_max: string; calendar_id?: string; query?: string; max?: number }> = {
    kind: "function",
    name: "cal_events",
    description: "List events between time_min and time_max (ISO 8601 with offset).",
    parameters: { type: "object", properties: { time_min: { type: "string" }, time_max: { type: "string" }, calendar_id: { type: "string" }, query: { type: "string" }, max: { type: "number" } }, required: ["time_min", "time_max"] },
    risk: "read",
    timeoutMs: 30_000,
    maxOutput: 15_000,
    label: (a) => `cal_events · ${a.time_min.slice(0, 16)} → ${a.time_max.slice(0, 16)}`,
    run: async (a) => {
      const list = await need().events({ calendarId: a.calendar_id, timeMin: a.time_min, timeMax: a.time_max, query: a.query, max: a.max });
      return { ok: true, output: list.length ? fence("CALENDAR", list.map(line).join("\n")) : "Không có sự kiện." };
    },
  };
  const freebusy: FunctionTool<{ time_min: string; time_max: string; calendar_ids?: string }> = {
    kind: "function",
    name: "cal_freebusy",
    description: "Busy intervals for calendars (comma-separated ids; default primary) between time_min and time_max.",
    parameters: { type: "object", properties: { time_min: { type: "string" }, time_max: { type: "string" }, calendar_ids: { type: "string" } }, required: ["time_min", "time_max"] },
    risk: "read",
    timeoutMs: 30_000,
    maxOutput: 8_000,
    label: (a) => `cal_freebusy · ${a.time_min.slice(0, 16)} → ${a.time_max.slice(0, 16)}`,
    run: async (a) => {
      const r = await need().freeBusy({ timeMin: a.time_min, timeMax: a.time_max, ids: a.calendar_ids?.split(",").map((s) => s.trim()).filter(Boolean) });
      return { ok: true, output: r.map((c) => `${c.id}${c.error ? " (lỗi)" : ""}: ${c.busy.length ? c.busy.map((b) => `${b.start}–${b.end}`).join(", ") : "rảnh"}`).join("\n") };
    },
  };
  const describeEv = (verb: string, a: EvArgs & { event_id?: string }) => ({
    tool: `cal_${verb}_event`,
    summary: `${verb === "create" ? "Tạo" : verb === "update" ? "Sửa" : "Xoá"} sự kiện${a.event_id ? ` ${a.event_id}` : ""}${a.summary ? ` “${clip(a.summary, 100)}”` : ""}${a.start ? ` · ${a.start}${a.end ? ` → ${a.end}` : ""}` : ""} (lịch ${a.calendar_id ?? "primary"}; không gửi lời mời)`,
    ...(a.description || a.location ? { preview: [a.location ? `Địa điểm: ${a.location}` : "", a.description ?? ""].filter(Boolean).join("\n").slice(0, 2_000) } : {}),
  });
  const create: FunctionTool<EvArgs> = {
    kind: "function",
    name: "cal_create_event",
    description: "Create an event (needs the owner's approval; no invitations are sent).",
    parameters: { type: "object", properties: eventProps, required: ["summary", "start", "end"] } as never,
    risk: "write",
    needsApproval: true,
    timeoutMs: 30_000,
    maxOutput: 2_000,
    label: (a) => `cal_create_event · ${clip(a.summary ?? "", 60)}`,
    describe: (a) => describeEv("create", a),
    check: async (a) => {
      const b = eventBody(a);
      return typeof b === "string" ? b : null;
    },
    run: async (a) => {
      const e = await need().create(a.calendar_id ?? "primary", eventBody(a) as Record<string, unknown>);
      return { ok: true, output: `Đã tạo: ${line(e)}` };
    },
  };
  const update: FunctionTool<EvArgs & { event_id: string }> = {
    kind: "function",
    name: "cal_update_event",
    description: "Update fields of an event (needs the owner's approval).",
    parameters: { type: "object", properties: { event_id: { type: "string" }, ...eventProps }, required: ["event_id"] } as never,
    risk: "write",
    needsApproval: true,
    timeoutMs: 30_000,
    maxOutput: 2_000,
    label: (a) => `cal_update_event · ${a.event_id.slice(0, 40)}`,
    describe: (a) => describeEv("update", a),
    check: async (a) => {
      const b = eventBody(a, true);
      return typeof b === "string" ? b : null;
    },
    run: async (a) => {
      const e = await need().update(a.calendar_id ?? "primary", a.event_id, eventBody(a, true) as Record<string, unknown>);
      return { ok: true, output: `Đã sửa: ${line(e)}` };
    },
  };
  const remove: FunctionTool<{ event_id: string; calendar_id?: string }> = {
    kind: "function",
    name: "cal_delete_event",
    description: "Delete an event (needs the owner's approval).",
    parameters: { type: "object", properties: { event_id: { type: "string" }, calendar_id: { type: "string" } }, required: ["event_id"] },
    risk: "write",
    needsApproval: true,
    timeoutMs: 30_000,
    maxOutput: 1_000,
    label: (a) => `cal_delete_event · ${a.event_id.slice(0, 40)}`,
    describe: (a) => describeEv("delete", a),
    run: async (a) => {
      await need().remove(a.calendar_id ?? "primary", a.event_id);
      return { ok: true, output: `Đã xoá sự kiện ${a.event_id}.` };
    },
  };
  return [calendars, events, freebusy, create, update, remove];
}
