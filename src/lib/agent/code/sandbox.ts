/**
 * W4 code-agent sandbox = the shell_run bwrap jail (unshare-all → no network, cleared env,
 * only the worktree writable; /usr incl. /usr/local/bin/node is read-only) plus: the worktree's
 * `.git` pointer bound read-only, /usr/local/bin on PATH, HOME=/tmp (tmpfs) so caches never land in the diff. bwrap is required.
 */
import fs from "node:fs";
import path from "node:path";
import { findBwrap, runSandboxed } from "../tools/sandbox.ts";

export function codeSandboxArgs(wt: string): string[] {
  const args: string[] = [];
  if (fs.existsSync(path.join(wt, ".git"))) args.push("--ro-bind", path.join(wt, ".git"), "/workspace/.git");
  args.push("--setenv", "PATH", "/usr/local/bin:/usr/bin:/bin", "--setenv", "HOME", "/tmp", "--setenv", "CI", "1", "--setenv", "npm_config_offline", "true");
  return args;
}

export function codeSandboxReady(): boolean {
  return findBwrap() !== null;
}

export async function runInWorktree(wt: string, command: string, timeoutMs: number, signal?: AbortSignal) {
  if (!codeSandboxReady()) return { ok: false, exitCode: null, output: "bwrap is required for the code agent", timedOut: false };
  const r = await runSandboxed({ workspace: wt, command, timeoutMs, network: false, signal, extraArgs: codeSandboxArgs(wt) });
  return { ok: r.ok, exitCode: r.exitCode, output: r.output, timedOut: r.timedOut };
}
