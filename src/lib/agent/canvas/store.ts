/**
 * Canvas Pages store (W2). One directory per page:
 *   <dataDir>/canvases/<id>/meta.json   title + version list
 *   <dataDir>/canvases/<id>/v<n>.html   immutable source of version n
 * Source is stored verbatim and never executed on the server (D3: no Node eval);
 * it only ever renders inside a sandboxed iframe with a strict CSP (see render.ts).
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { writeAtomic } from "../jobs/db.ts";

export const MAX_HTML = 512 * 1024;
export const MAX_TITLE = 120;
export const MAX_VERSIONS = 50;
export const MAX_CANVASES = 500;
const ID = /^c_[a-z0-9]{8,32}$/;

export type CanvasVersion = { version: number; at: number; bytes: number; note?: string; by: "owner" | "agent" };
export type CanvasMeta = { id: string; title: string; version: number; createdAt: number; updatedAt: number; versions: CanvasVersion[] };
export type CanvasSummary = { id: string; title: string; version: number; createdAt: number; updatedAt: number; bytes: number };
export type CanvasDoc = CanvasMeta & { html: string; shownVersion: number; bytes: number };

export function validCanvasId(id: unknown): id is string {
  return typeof id === "string" && ID.test(id);
}

export function cleanTitle(title: unknown): string {
  const t = typeof title === "string" ? title.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim() : "";
  return (t || "Canvas").slice(0, MAX_TITLE);
}

export type HtmlCheck = { ok: true; html: string } | { ok: false; error: string };
export function checkHtml(html: unknown): HtmlCheck {
  if (typeof html !== "string" || !html.trim()) return { ok: false, error: "html trống." };
  const bytes = Buffer.byteLength(html, "utf8");
  if (bytes > MAX_HTML) return { ok: false, error: `html quá lớn (${bytes} byte, tối đa ${MAX_HTML}).` };
  if (html.includes("\u0000")) return { ok: false, error: "html chứa ký tự NUL." };
  return { ok: true, html };
}

export class CanvasStore {
  readonly root: string;
  private now: () => number;
  constructor(dataDir: string, opts: { now?: () => number } = {}) {
    this.root = path.join(dataDir, "canvases");
    this.now = opts.now ?? Date.now;
  }

  private dir(id: string) {
    if (!validCanvasId(id)) throw new Error("bad canvas id");
    return path.join(this.root, id);
  }

  private readMeta(id: string): CanvasMeta | null {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.dir(id), "meta.json"), "utf8")) as CanvasMeta;
      return raw && raw.id === id && Array.isArray(raw.versions) ? raw : null;
    } catch {
      return null;
    }
  }

  private writeMeta(meta: CanvasMeta) {
    writeAtomic(path.join(this.dir(meta.id), "meta.json"), JSON.stringify(meta, null, 2));
  }

  list(): CanvasSummary[] {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.root);
    } catch {
      return [];
    }
    const out: CanvasSummary[] = [];
    for (const name of names) {
      if (!validCanvasId(name)) continue;
      const meta = this.readMeta(name);
      if (!meta) continue;
      const cur = meta.versions.find((v) => v.version === meta.version);
      out.push({ id: meta.id, title: meta.title, version: meta.version, createdAt: meta.createdAt, updatedAt: meta.updatedAt, bytes: cur?.bytes ?? 0 });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string, version?: number | null): CanvasDoc | null {
    if (!validCanvasId(id)) return null;
    const meta = this.readMeta(id);
    if (!meta) return null;
    const want = version && Number.isInteger(version) && version > 0 ? version : meta.version;
    const entry = meta.versions.find((v) => v.version === want);
    if (!entry) return null;
    let html: string;
    try {
      html = fs.readFileSync(path.join(this.dir(id), `v${want}.html`), "utf8");
    } catch {
      return null;
    }
    return { ...meta, html, shownVersion: want, bytes: entry.bytes };
  }

  create(input: { title?: unknown; html: unknown; note?: string; by?: "owner" | "agent" }): { ok: true; canvas: CanvasMeta } | { ok: false; error: string } {
    const check = checkHtml(input.html);
    if (!check.ok) return check;
    if (this.list().length >= MAX_CANVASES) return { ok: false, error: `Đã đủ ${MAX_CANVASES} canvas; xóa bớt trước.` };
    const id = `c_${randomBytes(8).toString("hex")}`;
    const at = this.now();
    fs.mkdirSync(this.dir(id), { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    writeAtomic(path.join(this.dir(id), "v1.html"), check.html);
    const meta: CanvasMeta = {
      id,
      title: cleanTitle(input.title),
      version: 1,
      createdAt: at,
      updatedAt: at,
      versions: [{ version: 1, at, bytes: Buffer.byteLength(check.html, "utf8"), by: input.by ?? "owner", ...(input.note ? { note: input.note.slice(0, 200) } : {}) }],
    };
    this.writeMeta(meta);
    return { ok: true, canvas: meta };
  }

  /** Adds a new immutable version (old versions stay readable until MAX_VERSIONS). */
  update(id: string, input: { title?: unknown; html: unknown; note?: string; by?: "owner" | "agent" }): { ok: true; canvas: CanvasMeta } | { ok: false; error: string } {
    if (!validCanvasId(id)) return { ok: false, error: "Mã canvas không hợp lệ." };
    const meta = this.readMeta(id);
    if (!meta) return { ok: false, error: "Không tìm thấy canvas." };
    const check = checkHtml(input.html);
    if (!check.ok) return check;
    const at = Math.max(this.now(), meta.updatedAt);
    const version = meta.version + 1;
    writeAtomic(path.join(this.dir(id), `v${version}.html`), check.html);
    meta.versions.push({ version, at, bytes: Buffer.byteLength(check.html, "utf8"), by: input.by ?? "owner", ...(input.note ? { note: input.note.slice(0, 200) } : {}) });
    while (meta.versions.length > MAX_VERSIONS) {
      const old = meta.versions.shift();
      if (old) fs.rmSync(path.join(this.dir(id), `v${old.version}.html`), { force: true });
    }
    meta.version = version;
    meta.updatedAt = at;
    if (input.title !== undefined) meta.title = cleanTitle(input.title);
    this.writeMeta(meta);
    return { ok: true, canvas: meta };
  }

  remove(id: string): boolean {
    if (!validCanvasId(id) || !this.readMeta(id)) return false;
    fs.rmSync(this.dir(id), { recursive: true, force: true });
    return true;
  }
}
