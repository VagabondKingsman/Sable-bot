/**
 * W4 git plumbing for the code agent (server side, never inside the sandbox).
 * - Minimal env (no Sable secrets), empty HOME, no system config, hooks disabled, no prompts.
 * - Worktree ops pin --git-dir/--work-tree recorded at creation, so a sandboxed command that
 *   rewrites the worktree's `.git` file cannot redirect git at another repository.
 * - Apply = local `merge --no-ff` of branch sable/<task> into the repo's current branch, only
 *   when the repo is clean and on a branch; conflicts abort. Never pushes (D6: no PRs).
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { within, type CodeConfig } from "./config.ts";

export type GitOut = { code: number; stdout: string; stderr: string };
export const MAX_DIFF = 400_000;

export function gitEnv(home: string): NodeJS.ProcessEnv {
  return { PATH: "/usr/bin:/bin", HOME: home, LANG: "C.UTF-8", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_ASKPASS: "/bin/false", SSH_ASKPASS: "/bin/false" };
}
const SAFE = ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Sable code agent", "-c", "user.email=sable@localhost", "-c", "core.fsmonitor=false", "-c", "protocol.allow=never"];

export function git(cfg: CodeConfig, args: string[], cwd?: string, timeoutMs = 30_000): Promise<GitOut> {
  const home = path.join(cfg.root, ".home");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  return new Promise((resolve) => {
    execFile("/usr/bin/git", [...SAFE, ...args], { cwd, env: gitEnv(home), timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr).slice(0, 4000) });
    });
  });
}

export async function validateRepo(cfg: CodeConfig, raw: unknown): Promise<{ ok: true; top: string } | { ok: false; error: string }> {
  if (typeof raw !== "string" || !path.isAbsolute(raw.trim())) return { ok: false, error: "repo must be an absolute path" };
  let real: string;
  try {
    real = fs.realpathSync(raw.trim());
  } catch {
    return { ok: false, error: "repo path does not exist" };
  }
  if (!cfg.repoRoots.some((r) => within(real, r))) return { ok: false, error: `repo is outside SABLE_CODE_REPOS (${cfg.repoRoots.join(", ")})` };
  if (cfg.denied.some((d) => within(real, d) || within(d, real)) || within(real, cfg.root)) return { ok: false, error: "repo path is protected" };
  const top = await git(cfg, ["-C", real, "rev-parse", "--show-toplevel"]);
  if (top.code !== 0) return { ok: false, error: "not a git repository" };
  if (fs.realpathSync(top.stdout.trim()) !== real) return { ok: false, error: `not the repository top-level (use ${top.stdout.trim()})` };
  return { ok: true, top: real };
}

export type Worktree = { repo: string; wt: string; branch: string; base: string; gitDir: string };

export async function createWorktree(cfg: CodeConfig, repo: string, id: string, baseRef = "HEAD"): Promise<{ ok: true; w: Worktree } | { ok: false; error: string }> {
  if (!/^[a-f0-9]{12}$/.test(id)) return { ok: false, error: "bad task id" };
  const base = await git(cfg, ["-C", repo, "rev-parse", "--verify", `${baseRef}^{commit}`]);
  if (base.code !== 0) return { ok: false, error: "base ref not found" };
  const dir = path.join(cfg.root, id);
  const wt = path.join(dir, "wt");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const branch = `sable/${id}`;
  const add = await git(cfg, ["-C", repo, "worktree", "add", "-b", branch, wt, base.stdout.trim()], undefined, 120_000);
  if (add.code !== 0) return { ok: false, error: `git worktree add failed: ${add.stderr.slice(0, 300)}` };
  const dotgit = fs.readFileSync(path.join(wt, ".git"), "utf8").trim();
  const gitDir = dotgit.replace(/^gitdir:\s*/, "");
  const common = (await git(cfg, ["-C", repo, "rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim();
  if (!within(path.resolve(gitDir), common)) return { ok: false, error: "unexpected worktree gitdir" };
  return { ok: true, w: { repo, wt, branch, base: base.stdout.trim(), gitDir: path.resolve(gitDir) } };
}

const wtArgs = (w: Worktree) => [`--git-dir=${w.gitDir}`, `--work-tree=${w.wt}`, "-C", w.wt];

export async function snapshot(cfg: CodeConfig, w: Worktree): Promise<{ diff: string; stat: string; files: { status: string; path: string }[]; truncated: boolean }> {
  await git(cfg, [...wtArgs(w), "add", "-A"]);
  const stat = await git(cfg, [...wtArgs(w), "diff", "--cached", "--stat", "--no-color", w.base]);
  const names = await git(cfg, [...wtArgs(w), "diff", "--cached", "--name-status", "--no-color", w.base]);
  const diff = await git(cfg, [...wtArgs(w), "diff", "--cached", "--no-color", "--no-ext-diff", "--no-textconv", w.base]);
  const files = names.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [status, ...rest] = l.split("\t");
      return { status: status!, path: rest.join(" → ") };
    });
  const truncated = diff.stdout.length > MAX_DIFF;
  return { diff: truncated ? diff.stdout.slice(0, MAX_DIFF) : diff.stdout, stat: stat.stdout.slice(0, 20_000), files: files.slice(0, 500), truncated };
}

export async function commitWorktree(cfg: CodeConfig, w: Worktree, message: string): Promise<{ ok: boolean; head?: string; error?: string }> {
  await git(cfg, [...wtArgs(w), "add", "-A"]);
  const st = await git(cfg, [...wtArgs(w), "diff", "--cached", "--quiet"]);
  if (st.code === 0) {
    const head = await git(cfg, [...wtArgs(w), "rev-parse", "HEAD"]);
    return head.stdout.trim() === w.base ? { ok: false, error: "no changes to apply" } : { ok: true, head: head.stdout.trim() };
  }
  const c = await git(cfg, [...wtArgs(w), "commit", "-q", "--no-verify", "-m", message.slice(0, 2000)]);
  if (c.code !== 0) return { ok: false, error: `commit failed: ${c.stderr.slice(0, 300)}` };
  return { ok: true, head: (await git(cfg, [...wtArgs(w), "rev-parse", "HEAD"])).stdout.trim() };
}

/** Owner-approved apply: merge sable/<id> into the repo's current branch. */
export async function applyWorktree(cfg: CodeConfig, w: Worktree, message: string): Promise<{ ok: true; head: string; into: string } | { ok: false; error: string }> {
  const sym = await git(cfg, ["-C", w.repo, "symbolic-ref", "-q", "--short", "HEAD"]);
  if (sym.code !== 0) return { ok: false, error: "repo HEAD is detached — check out a branch first" };
  const into = sym.stdout.trim();
  if (into.startsWith("sable/")) return { ok: false, error: "refusing to merge into a sable/* branch" };
  const dirty = await git(cfg, ["-C", w.repo, "status", "--porcelain", "--untracked-files=no"]);
  if (dirty.stdout.trim()) return { ok: false, error: "repo has uncommitted changes — commit or stash them first" };
  const c = await commitWorktree(cfg, w, message);
  if (!c.ok) return { ok: false, error: c.error ?? "commit failed" };
  const m = await git(cfg, ["-C", w.repo, "merge", "--no-ff", "--no-edit", "-m", `Merge ${w.branch} (owner-approved): ${message}`.slice(0, 2000), w.branch], undefined, 120_000);
  if (m.code !== 0) {
    await git(cfg, ["-C", w.repo, "merge", "--abort"]);
    return { ok: false, error: `merge failed (aborted, repo unchanged): ${(m.stderr || m.stdout).slice(0, 300)}` };
  }
  return { ok: true, head: (await git(cfg, ["-C", w.repo, "rev-parse", "HEAD"])).stdout.trim(), into };
}

export async function discardWorktree(cfg: CodeConfig, w: Worktree, dropBranch = true): Promise<void> {
  await git(cfg, ["-C", w.repo, "worktree", "remove", "--force", w.wt], undefined, 60_000);
  if (dropBranch) await git(cfg, ["-C", w.repo, "branch", "-D", w.branch]);
  await git(cfg, ["-C", w.repo, "worktree", "prune"]);
  const dir = path.dirname(w.wt);
  if (within(dir, cfg.root) && dir !== cfg.root) fs.rmSync(dir, { recursive: true, force: true });
}

/** Undo side effects of a command (e.g. the final test run) back to the staged snapshot. */
export async function resetToIndex(cfg: CodeConfig, w: Worktree): Promise<void> {
  await git(cfg, [...wtArgs(w), "clean", "-fdq"]);
  await git(cfg, [...wtArgs(w), "checkout", "--", "."]);
}
