/**
 * Workspace file tools. Every path is jailed to `ctx.workspaceDir`: no
 * absolute escapes, no `..`, no symlink hops outside. Writes need approval.
 */
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { FunctionTool, ToolContext } from "./types.ts";

export const MAX_READ_BYTES = 512_000;
export const MAX_WRITE_BYTES = 1_000_000;
export const MAX_WORKSPACE_BYTES = 200 * 1024 * 1024;
const MAX_LIST = 200;

function inside(root: string, target: string) {
  return target === root || target.startsWith(root + path.sep);
}

/** Resolve `rel` inside `root` or throw. Works for paths that do not exist yet. */
export async function jail(root: string, rel: string): Promise<string> {
  if (typeof rel !== "string" || rel.includes("\0")) throw new Error("bad path");
  if (rel.length > 400) throw new Error("path too long");
  await fs.mkdir(root, { recursive: true });
  const realRoot = await fs.realpath(root);
  // Model paths are workspace-relative; a leading "/" or "./" means the workspace root.
  const cleaned = rel.trim().replace(/^([/\\]|\.\/)+/, "");
  const target = path.resolve(realRoot, cleaned || ".");
  if (!inside(realRoot, target)) throw new Error("outside workspace");
  // Walk up to the nearest existing entry; it must resolve inside the jail. A symlink
  // anywhere on that path must resolve inside too: a dangling link (realpath fails)
  // is refused, otherwise a write would follow it and create a file outside.
  let probe = target;
  for (;;) {
    const link = await fs.lstat(probe).catch(() => null);
    if (link) {
      const real = await fs.realpath(probe).catch(() => null);
      if (!real || !inside(realRoot, real)) throw new Error("outside workspace");
      break;
    }
    const parent = path.dirname(probe);
    if (parent === probe) throw new Error("outside workspace");
    probe = parent;
  }
  return target;
}

function relOf(root: string, target: string) {
  return path.relative(root, target) || ".";
}

function looksBinary(buffer: Buffer) {
  const head = buffer.subarray(0, 8_192);
  return head.includes(0);
}

async function dirBytes(dir: string, budget = 20_000): Promise<number> {
  let total = 0;
  let seen = 0;
  const walk = async (current: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (++seen > budget) return;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) total += (await fs.stat(full).catch(() => ({ size: 0 }))).size;
    }
  };
  await walk(dir);
  return total;
}

async function realRootOf(ctx: ToolContext) {
  await fs.mkdir(ctx.workspaceDir, { recursive: true });
  return fs.realpath(ctx.workspaceDir);
}

export const fsList: FunctionTool<{ path?: string; depth?: number }> = {
  kind: "function",
  name: "fs_list",
  description: "List files and folders in the Sable workspace folder on the server (not the user's device). Paths are relative to the workspace root.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Folder relative to the workspace root. Default: root.", maxLength: 400 },
      depth: { type: "integer", description: "1-3 levels. Default 1.", minimum: 1, maximum: 3 },
    },
    additionalProperties: false,
  },
  risk: "read",
  timeoutMs: 5_000,
  maxOutput: 8_000,
  label: (args) => `Liệt kê · ${args.path || "/"}`,
  async run(args, ctx) {
    const root = await realRootOf(ctx);
    const target = await jail(root, args.path ?? "");
    const stat = await fs.stat(target).catch(() => null);
    if (!stat) return { ok: false, output: `not found: ${relOf(root, target)}` };
    if (!stat.isDirectory()) return { ok: false, output: `not a folder: ${relOf(root, target)}` };
    const lines: string[] = [];
    const depth = Math.min(3, Math.max(1, args.depth ?? 1));
    const walk = async (dir: string, level: number) => {
      const entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (lines.length >= MAX_LIST) return;
        const full = path.join(dir, entry.name);
        const rel = relOf(root, full);
        if (entry.isDirectory()) {
          lines.push(`${rel}/`);
          if (level < depth) await walk(full, level + 1);
        } else if (entry.isFile()) {
          const size = (await fs.stat(full)).size;
          lines.push(`${rel}  (${size} B)`);
        }
      }
    };
    await walk(target, 1);
    const output = lines.length ? lines.join("\n") : "(empty)";
    return { ok: true, output: lines.length >= MAX_LIST ? `${output}\n…(first ${MAX_LIST} entries)` : output, detail: output.slice(0, 1_500) };
  },
};

export const fsRead: FunctionTool<{ path: string; start?: number }> = {
  kind: "function",
  name: "fs_read",
  description: "Read a UTF-8 text file from the Sable workspace folder (max 512 KB). Use start to page through long files.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the workspace root.", maxLength: 400 },
      start: { type: "integer", description: "Character offset to start from. Default 0.", minimum: 0 },
    },
    required: ["path"],
    additionalProperties: false,
  },
  risk: "read",
  timeoutMs: 5_000,
  maxOutput: 12_000,
  label: (args) => `Đọc tệp · ${args.path ?? "?"}`,
  async run(args, ctx) {
    const root = await realRootOf(ctx);
    const target = await jail(root, args.path);
    const stat = await fs.stat(target).catch(() => null);
    if (!stat || !stat.isFile()) return { ok: false, output: `not found: ${relOf(root, target)}` };
    if (stat.size > MAX_READ_BYTES) return { ok: false, output: `file is ${stat.size} B; the limit is ${MAX_READ_BYTES} B` };
    const buffer = await fs.readFile(target);
    if (looksBinary(buffer)) return { ok: false, output: "binary file; only text files can be read" };
    const text = buffer.toString("utf8");
    const start = Math.max(0, args.start ?? 0);
    const chunk = text.slice(start, start + 11_000);
    const more = start + chunk.length < text.length ? `\n…[${text.length - start - chunk.length} more chars; call again with start=${start + chunk.length}]` : "";
    return { ok: true, output: `${chunk}${more}`, detail: `${relOf(root, target)} · ${stat.size} B` };
  },
};

export const fsWrite: FunctionTool<{ path: string; content: string; mode?: "overwrite" | "append" }> = {
  kind: "function",
  name: "fs_write",
  description:
    "Create or change a text file in the Sable workspace folder (max 1 MB). The user must approve each write in the UI before it happens; if they reject, nothing changes.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the workspace root.", maxLength: 400 },
      content: { type: "string", description: "Full UTF-8 text to write.", maxLength: MAX_WRITE_BYTES },
      mode: { type: "string", enum: ["overwrite", "append"], description: "Default overwrite." },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  risk: "write",
  needsApproval: true,
  timeoutMs: 10_000,
  maxOutput: 2_000,
  label: (args) => `Ghi tệp · ${args.path ?? "?"}`,
  describe: (args) => ({
    tool: "fs_write",
    summary: `${args.mode === "append" ? "Nối thêm vào" : "Ghi"} ${args.path} (${Buffer.byteLength(args.content ?? "", "utf8")} B)`,
    preview: (args.content ?? "").slice(0, 800),
  }),
  /** Runs before the approval card: never ask the user to approve a write that cannot happen. */
  async check(args, ctx) {
    const root = await realRootOf(ctx);
    const target = await jail(root, args.path);
    if (target === root) return "path must name a file";
    const existing = await fs.lstat(target).catch(() => null);
    if (existing?.isDirectory()) return "path is a folder";
    if (existing?.isSymbolicLink()) return "refused: path is a symlink";
    return null;
  },
  async run(args, ctx) {
    const root = await realRootOf(ctx);
    const target = await jail(root, args.path);
    if (target === root) return { ok: false, output: "path must name a file" };
    const bytes = Buffer.byteLength(args.content, "utf8");
    if (bytes > MAX_WRITE_BYTES) return { ok: false, output: `content is ${bytes} B; the limit is ${MAX_WRITE_BYTES} B` };
    const existing = await fs.stat(target).catch(() => null);
    if (existing?.isDirectory()) return { ok: false, output: "path is a folder" };
    const used = await dirBytes(root);
    if (used + bytes > MAX_WORKSPACE_BYTES) return { ok: false, output: "workspace quota (200 MB) would be exceeded" };
    await fs.mkdir(path.dirname(target), { recursive: true });
    // Re-check after mkdir: the parent chain must still be inside.
    await jail(root, relOf(root, target));
    // O_NOFOLLOW: never write through a symlink, even one swapped in after the check.
    const { O_WRONLY, O_CREAT, O_APPEND, O_TRUNC, O_NOFOLLOW } = fsConstants;
    const flags = O_WRONLY | O_CREAT | O_NOFOLLOW | (args.mode === "append" ? O_APPEND : O_TRUNC);
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(target, flags, 0o644);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ELOOP") return { ok: false, output: "refused: path is a symlink" };
      throw error;
    }
    try {
      await handle.writeFile(args.content, "utf8");
    } finally {
      await handle.close();
    }
    const rel = relOf(root, target);
    return { ok: true, output: `wrote ${bytes} B to ${rel}${existing ? " (replaced existing file)" : " (new file)"}`, detail: `${rel} · ${bytes} B` };
  },
};
