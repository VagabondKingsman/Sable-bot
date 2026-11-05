import fs from "node:fs";
import path from "node:path";
import { TASK_SUBDIRS, taskWorkspacePath, tasksRoot } from "./paths.ts";

export function workspacesOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.SABLE_WORKSPACES ?? "1").trim() !== "0";
}

export type WorkspaceInfo = {
  id: string;
  root: string;
  exists: boolean;
  bytes?: number;
};

function dirBytes(root: string): number {
  let total = 0;
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile()) {
        try {
          total += fs.statSync(p).size;
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(root);
  return total;
}

export class WorkspaceStore {
  private readonly env: NodeJS.ProcessEnv;
  private readonly fallbackRoot: string;

  constructor(fallbackWorkspaceRoot: string, env: NodeJS.ProcessEnv = process.env) {
    this.fallbackRoot = path.resolve(fallbackWorkspaceRoot);
    this.env = env;
  }

  /** Jail root for a task; when workspaces killed, return shared fallback. */
  resolve(taskId: string | null | undefined): string {
    if (!taskId || !workspacesOn(this.env)) return this.fallbackRoot;
    return taskWorkspacePath(taskId, this.env);
  }

  ensure(taskId: string): WorkspaceInfo {
    const root = this.resolve(taskId);
    if (workspacesOn(this.env)) {
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      for (const sub of TASK_SUBDIRS) {
        fs.mkdirSync(path.join(root, sub), { recursive: true, mode: 0o700 });
      }
    } else {
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    }
    return { id: taskId, root, exists: true, bytes: dirBytes(root) };
  }

  wipe(taskId: string): boolean {
    if (!workspacesOn(this.env)) return false;
    const root = taskWorkspacePath(taskId, this.env);
    // Refuse to wipe anything outside tasks root.
    const base = tasksRoot(this.env);
    const rel = path.relative(base, root);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return false;
    try {
      fs.rmSync(root, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  info(taskId: string): WorkspaceInfo {
    const root = this.resolve(taskId);
    const exists = fs.existsSync(root);
    return { id: taskId, root, exists, bytes: exists ? dirBytes(root) : 0 };
  }

  list(): WorkspaceInfo[] {
    if (!workspacesOn(this.env)) return [];
    const base = tasksRoot(this.env);
    if (!fs.existsSync(base)) return [];
    return fs
      .readdirSync(base, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => this.info(d.name));
  }
}
