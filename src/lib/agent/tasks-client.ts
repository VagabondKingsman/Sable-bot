import { readError, withPrefix } from "@/lib/agent/client";

export type TaskSummary = {
  id: string;
  goal: string;
  status: string;
  stepCount: number;
  currentStepId?: string;
  usedTokens: number;
  usedUsd: number;
  updatedAt: number;
  workspaceId: string;
};

export const tasksApi = {
  async list(signal?: AbortSignal) {
    const res = await fetch(withPrefix("/api/tasks"), { signal, cache: "no-store" });
    if (!res.ok) throw new Error(await readError(res, "Không tải được tasks."));
    return (await res.json()) as { enabled: boolean; items: TaskSummary[] };
  },
  async get(id: string, signal?: AbortSignal) {
    const res = await fetch(withPrefix(`/api/tasks?id=${encodeURIComponent(id)}`), { signal, cache: "no-store" });
    if (!res.ok) throw new Error(await readError(res, "Không tải được task."));
    return res.json();
  },
  async act(body: Record<string, unknown>) {
    const res = await fetch(withPrefix("/api/tasks"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await readError(res, "Thao tác task thất bại."));
    return res.json();
  },
};
