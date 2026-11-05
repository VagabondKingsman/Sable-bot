import path from "node:path";

/** Root for all task workspaces. Override with SABLE_TASK_WORKSPACE_ROOT. */
export function tasksRoot(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.SABLE_TASK_WORKSPACE_ROOT?.trim();
  return path.resolve(raw || "/workspace/sable-workspace/tasks");
}

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

export function assertTaskId(id: string): string {
  if (!ID_RE.test(id)) throw new Error("invalid task id");
  return id;
}

export function taskWorkspacePath(taskId: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(tasksRoot(env), assertTaskId(taskId));
}

export const TASK_SUBDIRS = ["in", "out", "tmp", "logs", "artifacts"] as const;
