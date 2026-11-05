import { readError, withPrefix } from "@/lib/agent/client";
import type { InboxItem, Job, JobSummary, Routine } from "@/lib/agent/jobs/types";
import type { ChatRequest } from "@/lib/agent/types";

export type JobsOverview = {
  enabled: boolean;
  routinesEnabled: boolean;
  config: { concurrency: number; maxSteps: number; timeoutMin: number; approvalTtlHours: number };
  counts: { active: number; waiting: number };
  unread: number;
  jobs: JobSummary[];
};
export type JobsCounts = Pick<JobsOverview, "enabled" | "routinesEnabled" | "counts" | "unread">;
export type TriggerViewT = {
  webhook?: { createdAt: number; lastFiredAt?: number };
  watch?: { url: string; everyMin: number; nextCheckAt: number; lastCheckAt?: number; lastChangeAt?: number; failures: number; lastError?: string; lastHash?: string };
};
export type RoutineView = Omit<Routine, "trigger"> & { scheduleLabel: string; trigger?: TriggerViewT };

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(withPrefix(path), { signal, cache: "no-store" });
  if (!res.ok) throw new Error(await readError(res, "Không tải được."));
  return (await res.json()) as T;
}

async function post<T>(path: string, body: unknown, fallback: string): Promise<T> {
  const res = await fetch(withPrefix(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await readError(res, fallback));
  return (await res.json()) as T;
}

export const jobsApi = {
  counts: (signal?: AbortSignal) => getJson<JobsCounts>("/api/jobs?counts=1", signal),
  overview: (signal?: AbortSignal) => getJson<JobsOverview>("/api/jobs", signal),
  job: (id: string, signal?: AbortSignal) =>
    getJson<Job>(`/api/jobs?id=${encodeURIComponent(id)}`, signal),
  create: (request: ChatRequest, title?: string) =>
    post<{ id: string }>(
      "/api/jobs",
      { action: "create", request, title },
      "Không tạo được việc nền.",
    ),
  cancel: (id: string) =>
    post<{ ok: true }>("/api/jobs", { action: "cancel", id }, "Không hủy được."),
  remove: (id: string) =>
    post<{ ok: true }>("/api/jobs", { action: "delete", id }, "Không xóa được."),
  routines: (signal?: AbortSignal) =>
    getJson<{ enabled: boolean; triggersEnabled?: boolean; now: number; routines: RoutineView[] }>("/api/routines", signal),
  saveRoutine: (input: Record<string, unknown>, id?: string) =>
    post<RoutineView>(
      "/api/routines",
      { ...input, action: id ? "update" : "create", id },
      "Không lưu được lịch chạy.",
    ),
  toggleRoutine: (id: string, enabled: boolean) =>
    post<RoutineView>("/api/routines", { action: "toggle", id, enabled }, "Không đổi được."),
  deleteRoutine: (id: string) =>
    post<{ ok: true }>("/api/routines", { action: "delete", id }, "Không xóa được."),
  setWebhook: (id: string, on: boolean) =>
    post<{ secret?: string }>("/api/routines", { action: "webhook", id, on }, "Không đổi được webhook."),
  setWatch: (id: string, watch: { url: string; everyMin: number } | null) =>
    post<RoutineView>("/api/routines", { action: "watch", id, watch }, "Không lưu được theo dõi."),
  runRoutine: (id: string) =>
    post<{ id: string }>("/api/routines", { action: "run", id }, "Không chạy được."),
  inbox: (signal?: AbortSignal) =>
    getJson<{ unread: number; items: InboxItem[] }>("/api/inbox", signal),
  markRead: (ids: string[] | "all") =>
    post<{ unread: number }>("/api/inbox", { action: "read", ids }, "Không đánh dấu được."),
  removeInbox: (ids: string[] | "all") =>
    post<{ unread: number }>("/api/inbox", { action: "delete", ids }, "Không xóa được."),
};

const STAMP = new Intl.DateTimeFormat("vi-VN", {
  timeZone: "Asia/Saigon",
  hour: "2-digit",
  minute: "2-digit",
  day: "2-digit",
  month: "2-digit",
  hour12: false,
});

/** Times are always shown in Asia/Saigon (UTC+7). */
export function saigonTime(ms: number | null | undefined) {
  if (!ms) return "—";
  return `${STAMP.format(new Date(ms))} (GMT+7)`;
}
