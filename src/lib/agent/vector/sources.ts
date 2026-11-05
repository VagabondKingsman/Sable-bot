/**
 * W5 collectors: turn Sable's on-disk stores into indexable docs. Read-only.
 * NEVER indexed: the vault (vault.json), audit/traces/jobs/inbox internals, code worktrees,
 * secret-looking files (.env, keys, credentials, tokens). Every text is redacted by the indexer
 * (redactSecrets) before chunking/embedding; workspace files with private-key blocks are skipped.
 */
import fs from "node:fs";
import path from "node:path";
import { htmlText } from "./chunk.ts";
import type { SourceKind } from "./store.ts";

export type Doc = { key: string; source: SourceKind; title: string; ref: string; at: number; text: string };

const readJson = <T,>(file: string): T | null => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
};

export function memoryDocs(dataDir: string): Doc[] {
  const d = readJson<{ items?: { id: string; kind: string; text: string; createdAt?: number; updatedAt?: number; eventDate?: string }[] }>(path.join(dataDir, "memory.json"));
  return (d?.items ?? []).map((m) => ({
    key: `mem:${m.id}`,
    source: m.kind === "journal" ? ("journal" as const) : ("memory" as const),
    title: m.kind === "journal" ? `Nhật ký${m.eventDate ? ` ${m.eventDate}` : ""}` : "Hồ sơ",
    ref: m.id,
    at: m.updatedAt ?? m.createdAt ?? 0,
    text: m.text,
  }));
}

export function threadDocs(dataDir: string, maxChars = 60_000): Doc[] {
  const d = readJson<{ threads?: Record<string, { thread: { id: string; title?: string; updatedAt?: number; messages?: { role: string; content: unknown }[] } }>; tombstones?: Record<string, unknown> }>(path.join(dataDir, "desk.json"));
  const dead = new Set(Object.keys(d?.tombstones ?? {}));
  const out: Doc[] = [];
  for (const [id, rec] of Object.entries(d?.threads ?? {})) {
    if (dead.has(id) || !rec?.thread) continue;
    const t = rec.thread;
    const text = (t.messages ?? [])
      .filter((m) => typeof m.content === "string" && (m.role === "user" || m.role === "assistant"))
      .map((m) => `${m.role === "user" ? "Người dùng" : "Sable"}: ${m.content as string}`)
      .join("\n\n")
      .slice(-maxChars);
    if (text.trim()) out.push({ key: `thread:${id}`, source: "thread", title: t.title || "Cuộc trò chuyện", ref: id, at: t.updatedAt ?? 0, text });
  }
  return out;
}

export function canvasDocs(dataDir: string): Doc[] {
  const root = path.join(dataDir, "canvases");
  const out: Doc[] = [];
  let ids: string[] = [];
  try {
    ids = fs.readdirSync(root).filter((n) => /^c_[a-f0-9]{8,32}$/.test(n));
  } catch {
    return out;
  }
  for (const id of ids) {
    const meta = readJson<{ title?: string; version?: number; updatedAt?: number }>(path.join(root, id, "meta.json"));
    if (!meta?.version) continue;
    try {
      const html = fs.readFileSync(path.join(root, id, `v${meta.version}.html`), "utf8").slice(0, 1_000_000);
      const text = htmlText(html);
      if (text) out.push({ key: `canvas:${id}`, source: "canvas", title: meta.title || id, ref: id, at: meta.updatedAt ?? 0, text });
    } catch {
      /* missing version file */
    }
  }
  return out;
}

function strings(v: unknown, acc: string[] = [], depth = 0): string[] {
  if (depth > 6) return acc;
  if (typeof v === "string") acc.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, acc, depth + 1);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, acc, depth + 1);
  return acc;
}

export function researchDocs(dataDir: string): Doc[] {
  const root = path.join(dataDir, "research");
  const out: Doc[] = [];
  let files: string[] = [];
  try {
    files = fs.readdirSync(root).filter((n) => /^[a-f0-9]{8,32}\.json$/.test(n));
  } catch {
    return out;
  }
  for (const f of files) {
    const r = readJson<{ id: string; question?: string; updatedAt?: number; report?: unknown; sources?: { id: string; url?: string; title?: string; text?: string }[] }>(path.join(root, f));
    if (!r?.id) continue;
    if (r.report) out.push({ key: `research:${r.id}:report`, source: "research", title: `Báo cáo: ${r.question ?? r.id}`.slice(0, 200), ref: r.id, at: r.updatedAt ?? 0, text: strings(r.report).join("\n") });
    for (const s of r.sources ?? []) {
      if (!s.text?.trim()) continue;
      out.push({ key: `research:${r.id}:${s.id}`, source: "research", title: (s.title || s.url || s.id).slice(0, 200), ref: s.url ? `${r.id} ${s.url}` : r.id, at: r.updatedAt ?? 0, text: s.text.slice(0, 200_000) });
    }
  }
  return out;
}

const DOC_EXT = new Set([".md", ".markdown", ".txt", ".csv", ".tsv", ".json", ".html", ".htm", ".rst", ".org", ".yaml", ".yml", ".xml", ".log"]);
const SKIP_DIRS = new Set(["code", ".home", ".git", "node_modules", ".cache", ".npm", ".venv", "venv", "__pycache__", "tmp", ".ssh", ".gnupg"]);
/** Secret-looking file names are never read. */
export const SECRET_NAME = /(^\.env|\.pem$|\.key$|\.p12$|\.pfx$|\.kdbx$|^id_(rsa|ed25519|ecdsa|dsa)|credential|secret|token|password|passwd|vault|authtoken|\.netrc$|\.npmrc$|\.pgpass$|cookies?\b)/i;

export function workspaceDocs(root: string, opts: { maxFiles?: number; maxBytes?: number } = {}): Doc[] {
  const maxFiles = opts.maxFiles ?? 2000;
  const maxBytes = opts.maxBytes ?? 1_000_000;
  const out: Doc[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 8 || out.length >= maxFiles) return;
    let ents: fs.Dirent[] = [];
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (out.length >= maxFiles) return;
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(full, depth + 1);
        continue;
      }
      if (!e.isFile() || SECRET_NAME.test(e.name) || !DOC_EXT.has(path.extname(e.name).toLowerCase())) continue;
      try {
        const st = fs.statSync(full);
        if (st.size > maxBytes || st.size === 0) continue;
        let text = fs.readFileSync(full, "utf8");
        if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) continue;
        if (/\.html?$/i.test(e.name)) text = htmlText(text);
        const rel = path.relative(root, full);
        out.push({ key: `ws:${rel}`, source: "workspace", title: rel, ref: rel, at: st.mtimeMs, text });
      } catch {
        /* unreadable */
      }
    }
  };
  walk(root, 0);
  return out;
}

export function collectAll(dataDir: string, workspaceRoot: string): Doc[] {
  return [...memoryDocs(dataDir), ...threadDocs(dataDir), ...canvasDocs(dataDir), ...researchDocs(dataDir), ...workspaceDocs(workspaceRoot)];
}
