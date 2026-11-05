/** Browser client for the W2a proactive APIs (triage, brief, audit). */
import { readError, withPrefix } from "@/lib/agent/client";
import type { TriagedItem } from "@/lib/agent/proactive/feed";
import type { BriefConfig, BriefRecord } from "@/lib/agent/proactive/store";
import type { TaskState, UnifiedTask } from "@/lib/agent/proactive/unify";

export type TasksInboxView = { triage: boolean; tasks: UnifiedTask[]; counts: Record<TaskState, number>; ignored: number };

export type TriageFeed = { enabled: boolean; items: TriagedItem[]; counts: Record<string, number>; model?: string | null };
export type BriefView = { enabled: boolean; config: BriefConfig; routineId: string; history: BriefRecord[]; preview: { title: string; text: string } | null };

async function get<T>(url: string, signal?: AbortSignal, fallback = "Không tải được."): Promise<T> {
  const res = await fetch(withPrefix(url), { signal, cache: "no-store" });
  if (!res.ok) throw new Error(await readError(res, fallback));
  return (await res.json()) as T;
}

async function post<T>(url: string, body: Record<string, unknown>, fallback = "Thao tác thất bại."): Promise<T> {
  const res = await fetch(withPrefix(url), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(await readError(res, fallback));
  return (await res.json()) as T;
}

export const proactiveApi = {
  tasksInbox: (signal?: AbortSignal, snoozed = false) => get<TasksInboxView>(`/api/tasks?view=inbox${snoozed ? "&snoozed=1" : ""}`, signal, "Không tải được Tasks."),
  triage: (signal?: AbortSignal) => get<TriageFeed>("/api/triage", signal, "Không tải được triage."),
  itemState: (id: string, action: "snooze" | "unsnooze" | "done" | "undone", ms?: number) => post("/api/triage", { id, action, ms }),
  brief: (signal?: AbortSignal, preview = false) => get<BriefView>(`/api/brief${preview ? "?preview=1" : ""}`, signal, "Không tải được bản tin."),
  briefConfig: (patch: Partial<Pick<BriefConfig, "enabled" | "time" | "tz" | "telegram">>) => post<{ ok: true; config: BriefConfig }>("/api/brief", { action: "config", ...patch }),
  briefRun: () => post<{ ok: true; brief: BriefRecord }>("/api/brief", { action: "run" }),
};

export const proactiveAuditApi = {
  list: (q: { jobId?: string; kind?: string; type?: string; limit?: number }, signal?: AbortSignal) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") u.set(k, String(v));
    return get<{ items: import("@/lib/agent/audit/types").AuditRecord[] }>(`/api/audit?${u}`, signal, "Không tải được audit.");
  },
};
