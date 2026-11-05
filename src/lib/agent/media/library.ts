/**
 * Media library: metadata in `<dataDir>/media/index.json` (0600), bytes in
 * `<workspace>/media/<id>.<ext>`. Ids are server-made; paths never come from input.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { writeAtomic } from "../jobs/db.ts";
import type { MediaItem } from "./types.ts";

export const MAX_ITEMS = 1_000;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 120 * 1024 * 1024;
const ID_RE = /^m_[a-z0-9]{6,40}$/;

export function sniffMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(4, 8)) === "ftyp") return "video/mp4";
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "video/webm";
  return null;
}

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "video/mp4": "mp4", "video/webm": "webm" };

export class MediaLibrary {
  readonly indexFile: string;
  readonly filesDir: string;
  private items: MediaItem[] | null = null;

  constructor(dataDir: string, workspaceDir: string) {
    this.indexFile = path.join(dataDir, "media", "index.json");
    this.filesDir = path.join(workspaceDir, "media");
  }

  static newId() {
    return `m_${Date.now().toString(36)}${crypto.randomBytes(4).toString("hex")}`;
  }

  static validId(id: string) {
    return ID_RE.test(id);
  }

  private load(): MediaItem[] {
    if (this.items) return this.items;
    try {
      const raw = JSON.parse(fs.readFileSync(this.indexFile, "utf8")) as { v: 1; items: MediaItem[] };
      this.items = Array.isArray(raw?.items) ? raw.items.filter((i) => i && MediaLibrary.validId(i.id)) : [];
    } catch {
      this.items = [];
    }
    return this.items;
  }

  private save() {
    fs.mkdirSync(path.dirname(this.indexFile), { recursive: true, mode: 0o700 });
    writeAtomic(this.indexFile, JSON.stringify({ v: 1, items: this.load() }));
  }

  list(): MediaItem[] {
    return [...this.load()].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): MediaItem | null {
    return this.load().find((i) => i.id === id) ?? null;
  }

  put(item: MediaItem) {
    const items = this.load();
    const at = items.findIndex((i) => i.id === item.id);
    if (at >= 0) items[at] = item;
    else items.push(item);
    // Cap: drop the oldest (and their files).
    while (items.length > MAX_ITEMS) {
      const oldest = items.sort((a, b) => a.createdAt - b.createdAt).shift()!;
      this.unlink(oldest);
    }
    this.save();
    return item;
  }

  /** Write bytes for an item; mime is sniffed from content (never trusted from the provider). */
  writeFile(item: MediaItem, bytes: Uint8Array): MediaItem {
    const max = item.kind === "image" ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
    if (bytes.byteLength > max) throw new Error("file too large");
    const mime = sniffMime(bytes);
    if (!mime || !mime.startsWith(`${item.kind}/`)) throw new Error(`provider returned non-${item.kind} bytes`);
    fs.mkdirSync(this.filesDir, { recursive: true, mode: 0o700 });
    const rel = `media/${item.id}.${EXT[mime]}`;
    const abs = path.join(this.filesDir, `${item.id}.${EXT[mime]}`);
    writeAtomic(abs, Buffer.from(bytes) as unknown as string);
    return { ...item, mime, bytes: bytes.byteLength, file: rel, status: "ready", updatedAt: Date.now(), remoteUrl: undefined };
  }

  filePath(item: MediaItem): string | null {
    if (!item.file || !MediaLibrary.validId(item.id)) return null;
    const name = path.basename(item.file);
    if (!name.startsWith(`${item.id}.`)) return null;
    const abs = path.join(this.filesDir, name);
    return fs.existsSync(abs) ? abs : null;
  }

  private unlink(item: MediaItem) {
    const abs = this.filePath(item);
    if (abs) fs.rmSync(abs, { force: true });
  }

  remove(id: string): boolean {
    const items = this.load();
    const at = items.findIndex((i) => i.id === id);
    if (at < 0) return false;
    this.unlink(items[at]!);
    items.splice(at, 1);
    this.save();
    return true;
  }
}
