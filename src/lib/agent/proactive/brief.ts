/**
 * Morning brief (W2a): a deterministic summary of what needs the owner —
 * triaged items, pending approvals, task progress and budget use. No model
 * call, so it costs nothing and cannot be steered by item content (titles are
 * quoted, clipped, and never interpreted). Idea from OpenDuet brief.ts (MIT,
 * CopilotKit); composition is Sable's own.
 */
import type { TriagedItem } from "./feed.ts";
import type { BriefConfig } from "./store.ts";

export type BriefTask = { id: string; goal: string; status: string; done: number; total: number; waiting: number };
export type BriefBudget = { totalTokens: number; usd: number; maxTokens?: number; maxUsd?: number };
/** W2b: today's calendar events (from Google Calendar when connected). */
export type BriefEvent = { summary: string; start: string; end?: string; allDay?: boolean; location?: string };
export type BriefApproval = { id: string; title: string; summary: string; initiatorKind?: string };

export type BriefInput = {
  now: Date;
  tz: string;
  triaged: TriagedItem[];
  approvals: BriefApproval[];
  tasks: BriefTask[];
  budget: BriefBudget | null;
  /** Only items newer than this (epoch ms) count as new; older open asks still show. */
  since?: number;
  /** null/undefined → section omitted (Calendar not connected). */
  events?: BriefEvent[] | null;
};

export type Brief = { title: string; text: string; counts: Record<string, number> };

const clip = (s: string, n = 90) => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

const hm = (iso: string, tz: string) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? localParts(new Date(t), tz).time : clip(iso, 16);
};

export function localParts(now: Date, tz: string) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

/** Today's slot (YYYY-MM-DD in tz) when the brief is due and not yet sent; else null. */
export function dueSlot(cfg: BriefConfig, now: Date): string | null {
  if (!cfg.enabled) return null;
  const { date, time } = localParts(now, cfg.tz);
  if (time < cfg.time) return null;
  if (cfg.lastSlot === date) return null;
  // Do not fire a stale brief late at night after a long outage: only within 3h of the slot.
  const [h, m] = cfg.time.split(":").map(Number);
  const [nh, nm] = time.split(":").map(Number);
  if (nh * 60 + nm - (h * 60 + m) > 180) return null;
  return date;
}

export function composeBrief(input: BriefInput): Brief {
  const { date, time } = localParts(input.now, input.tz);
  const open = input.triaged.filter((it) => !it.state?.done && !it.snoozed);
  const reply = open.filter((it) => it.result.bucket === "needs_reply");
  const fyi = open.filter((it) => it.result.bucket === "fyi" && (input.since === undefined || it.input.at >= input.since));
  const ignored = open.filter((it) => it.result.bucket === "ignore").length;
  const activeTasks = input.tasks.filter((t) => !["done", "cancelled"].includes(t.status));
  const lines: string[] = [];
  lines.push(`Bản tin sáng · ${date} ${time} (${input.tz})`);
  lines.push("");

  if (input.events) {
    lines.push(`Lịch hôm nay (${input.events.length})`);
    if (!input.events.length) lines.push("- Không có sự kiện.");
    for (const e of input.events.slice(0, 12)) lines.push(`- ${e.allDay ? "cả ngày" : `${hm(e.start, input.tz)}${e.end ? `–${hm(e.end, input.tz)}` : ""}`} ${clip(e.summary, 70)}${e.location ? ` @ ${clip(e.location, 40)}` : ""}`);
    lines.push("");
  }

  lines.push(`Cần duyệt (${input.approvals.length})`);
  if (!input.approvals.length) lines.push("- Không có gì chờ duyệt.");
  for (const a of input.approvals.slice(0, 10)) lines.push(`- ${clip(a.title, 60)}: ${clip(a.summary)}${a.initiatorKind ? ` [${a.initiatorKind}]` : ""}`);
  lines.push("");

  lines.push(`Cần bạn trả lời (${reply.length})`);
  if (!reply.length) lines.push("- Không có.");
  for (const it of reply.slice(0, 10)) lines.push(`- ${it.result.urgency === "high" ? "‼ " : ""}${clip(it.input.title, 60)} — ${clip(it.result.reason)}`);
  lines.push("");

  lines.push(`Để biết (${fyi.length})`);
  for (const it of fyi.slice(0, 8)) lines.push(`- ${clip(it.input.title, 60)} — ${clip(it.result.reason, 70)}`);
  if (!fyi.length) lines.push("- Không có gì mới.");
  if (ignored) lines.push(`(Đã bỏ qua ${ignored} mục: quảng cáo, tự động trả lời, không đổi…)`);
  lines.push("");

  lines.push(`Công việc (${activeTasks.length} đang mở)`);
  if (!activeTasks.length) lines.push("- Không có kế hoạch nào đang chạy.");
  for (const t of activeTasks.slice(0, 8)) lines.push(`- ${clip(t.goal, 60)}: ${t.done}/${t.total} bước · ${t.status}${t.waiting ? ` · ${t.waiting} chờ duyệt` : ""}`);
  lines.push("");

  if (input.budget) {
    const b = input.budget;
    const cap = [b.maxTokens ? `${Math.round((b.totalTokens / b.maxTokens) * 100)}% token cap` : "", b.maxUsd ? `${Math.round((b.usd / b.maxUsd) * 100)}% USD cap` : ""].filter(Boolean).join(", ");
    lines.push(`Ngân sách: ${b.totalTokens.toLocaleString("en-US")} tokens · $${b.usd.toFixed(2)}${cap ? ` (${cap})` : ""}`);
  }
  lines.push("");
  lines.push("Mọi gửi đi vẫn cần bạn duyệt. Gợi ý trả lời chỉ mở bản nháp.");

  const counts = { ...(input.events ? { events: input.events.length } : {}), approvals: input.approvals.length, needs_reply: reply.length, fyi: fyi.length, ignored, tasks: activeTasks.length };
  const title = `Bản tin sáng ${date}: ${counts.approvals} chờ duyệt · ${counts.needs_reply} cần trả lời`;
  return { title, text: lines.join("\n").replace(/\n{3,}/g, "\n\n").trim(), counts };
}
