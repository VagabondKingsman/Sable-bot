/**
 * W4 code worktree agent defaults. Kill switch SABLE_CODEAGENT=0.
 * Worktrees live only under <SABLE_WORKSPACE>/code/<task>/ (default /workspace/sable-workspace/code).
 * Repos: SABLE_CODE_REPOS = comma list of allowed roots (default /workspace); protected
 * research checkouts, the data dir and the workspace itself are always refused.
 * D6: GitHub PR creation is off (no token use, no push) — apply = local merge after owner approval.
 */
import path from "node:path";

export type CodeConfig = {
  enabled: boolean;
  root: string;
  repoRoots: string[];
  denied: string[];
  runUsd: number;
  maxSteps: number;
  cmdTimeoutMs: number;
  model: string;
  github: false;
};

const num = (raw: string | undefined, def: number, min: number, max: number) => {
  const n = Number(raw);
  return raw === undefined || raw === "" || !Number.isFinite(n) ? def : Math.min(max, Math.max(min, n));
};

export function codeConfig(env: Record<string, string | undefined> = process.env): CodeConfig {
  const ws = path.resolve(env.SABLE_WORKSPACE?.trim() || "/workspace/sable-workspace");
  const roots = (env.SABLE_CODE_REPOS ?? "/workspace")
    .split(",")
    .map((x) => x.trim())
    .filter((x) => path.isAbsolute(x))
    .map((x) => path.resolve(x));
  return {
    enabled: env.SABLE_CODEAGENT !== "0",
    root: path.join(ws, "code"),
    repoRoots: roots.length ? roots : ["/workspace"],
    denied: [
      "/workspace/reverse-skill-research",
      "/workspace/openduet-research",
      path.resolve(env.SABLE_DATA_DIR?.trim() || "/workspace/sable-data"),
      ws,
      "/home",
      "/root",
      "/etc",
    ],
    runUsd: num(env.SABLE_CODE_RUN_USD, 0.5, 0.01, 5),
    maxSteps: Math.floor(num(env.SABLE_CODE_MAX_STEPS, 20, 3, 60)),
    cmdTimeoutMs: Math.floor(num(env.SABLE_CODE_CMD_TIMEOUT_S, 60, 5, 120)) * 1000,
    model: (env.SABLE_CODE_MODEL || "grok-4.5").trim().slice(0, 60),
    github: false,
  };
}

export const within = (p: string, root: string) => {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};
