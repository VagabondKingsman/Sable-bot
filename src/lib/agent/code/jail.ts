/**
 * W4 fs jail for the code agent: every path is relative to the task worktree, resolved,
 * and its real path (symlinks followed) must stay inside the worktree. `.git` is never
 * readable or writable. Writes never follow an existing symlink.
 */
import fs from "node:fs";
import path from "node:path";
import { within } from "./config.ts";

export const MAX_READ = 200_000;
export const MAX_WRITE = 200_000;

export type Jailed = { ok: true; abs: string; rel: string } | { ok: false; error: string };

export function jailPath(wt: string, raw: unknown): Jailed {
  if (typeof raw !== "string" || !raw.trim()) return { ok: false, error: "path required" };
  if (raw.includes("\0")) return { ok: false, error: "NUL in path" };
  if (path.isAbsolute(raw)) return { ok: false, error: "absolute paths are not allowed (use paths relative to the worktree)" };
  const root = fs.realpathSync(wt);
  const abs = path.resolve(root, raw);
  if (!within(abs, root)) return { ok: false, error: "path escapes the worktree" };
  const rel = path.relative(root, abs) || ".";
  if (rel.split(path.sep).some((seg) => seg === ".git")) return { ok: false, error: ".git is off limits" };
  // Real path of the nearest existing ancestor must be inside too (symlinked dirs).
  let probe = abs;
  while (!fs.existsSync(probe)) probe = path.dirname(probe);
  const real = fs.realpathSync(probe);
  if (!within(real, root)) return { ok: false, error: "path resolves outside the worktree (symlink)" };
  return { ok: true, abs, rel };
}

export function jailList(wt: string, raw = "."): string {
  const j = jailPath(wt, raw);
  if (!j.ok) return `error: ${j.error}`;
  const st = fs.statSync(j.abs, { throwIfNoEntry: false });
  if (!st?.isDirectory()) return "error: not a directory";
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === ".git" || e.name === "node_modules") continue;
      const p = path.join(dir, e.name);
      const rel = path.relative(fs.realpathSync(wt), p);
      out.push(e.isDirectory() ? `${rel}/` : e.isSymbolicLink() ? `${rel} -> (symlink)` : rel);
      if (out.length >= 300) return;
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
    }
  };
  walk(j.abs, 0);
  return out.join("\n") || "(empty)";
}

export function jailRead(wt: string, raw: unknown): string {
  const j = jailPath(wt, raw);
  if (!j.ok) return `error: ${j.error}`;
  const st = fs.lstatSync(j.abs, { throwIfNoEntry: false });
  if (!st) return "error: no such file";
  if (st.isSymbolicLink()) {
    const real = fs.realpathSync(j.abs);
    if (!within(real, fs.realpathSync(wt))) return "error: symlink points outside the worktree";
  }
  if (!fs.statSync(j.abs).isFile()) return "error: not a file";
  const buf = fs.readFileSync(j.abs);
  if (buf.includes(0)) return "error: binary file";
  return buf.length > MAX_READ ? `${buf.subarray(0, MAX_READ).toString("utf8")}\n…[truncated]` : buf.toString("utf8");
}

export function jailWrite(wt: string, raw: unknown, content: unknown): { ok: boolean; message: string } {
  const j = jailPath(wt, raw);
  if (!j.ok) return { ok: false, message: j.error };
  if (typeof content !== "string") return { ok: false, message: "content must be a string" };
  if (Buffer.byteLength(content) > MAX_WRITE) return { ok: false, message: `content too large (max ${MAX_WRITE} bytes)` };
  const st = fs.lstatSync(j.abs, { throwIfNoEntry: false });
  if (st?.isSymbolicLink()) return { ok: false, message: "refusing to write through a symlink" };
  if (st?.isDirectory()) return { ok: false, message: "path is a directory" };
  fs.mkdirSync(path.dirname(j.abs), { recursive: true });
  const again = jailPath(wt, raw); // parent dirs just created: re-check
  if (!again.ok) return { ok: false, message: again.error };
  fs.writeFileSync(j.abs, content, { mode: 0o644 });
  return { ok: true, message: `wrote ${j.rel} (${Buffer.byteLength(content)} bytes)` };
}
