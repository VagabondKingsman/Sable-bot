/** Browser client for the W2a proactive APIs (triage, brief, audit). */
import { readError, withPrefix } from "@/lib/agent/client";
import type { TriagedItem } from "@/lib/agent/proactive/feed";
import type { BriefConfig, BriefRecord } from "@/lib/agent/proactive/store";

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
  triage: (signal?: AbortSignal) => get<TriageFeed>("/api/triage", signal, "Không tải được triage."),
  itemState: (id: string, action: "snooze" | "unsnooze" | "done" | "undone", ms?: number) => post("/api/triage", { id, action, ms }),
  brief: (signal?: AbortSignal, preview = false) => get<BriefView>(`/api/brief${preview ? "?preview=1" : ""}`, signal, "Không tải được bản tin."),
  briefConfig: (patch: Partial<Pick<BriefConfig, "enabled" | "time" | "tz" | "telegram">>) => post<{ ok: true; config: BriefConfig }>("/api/brief", { action: "config", ...patch }),
  briefRun: () => post<{ ok: true; brief: BriefRecord }>("/api/brief", { action: "run" }),
};
