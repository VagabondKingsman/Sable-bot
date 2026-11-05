/**
 * canvas_write — the agent writes (or revises) an interactive Canvas Page.
 * Always needs the owner's approval (it persists content and is shareable via
 * the authenticated desk link). Rendered only in a sandboxed iframe + CSP (D3).
 * Kill switch: SABLE_CANVAS=0.
 */
import { dataDir } from "../../../server/paths.ts";
import { CanvasStore, MAX_HTML, checkHtml, cleanTitle, validCanvasId } from "../canvas/store.ts";
import type { FunctionTool } from "./types.ts";

export function canvasOn() {
  return (process.env.SABLE_CANVAS ?? "1").trim() !== "0";
}

let store: { dir: string; store: CanvasStore } | null = null;
export function canvasStore(): CanvasStore {
  const dir = dataDir();
  if (!store || store.dir !== dir) store = { dir, store: new CanvasStore(dir) };
  return store.store;
}

type Args = { title: string; html: string; id?: string; note?: string };

export const canvasWrite: FunctionTool<Args> = {
  kind: "function",
  name: "canvas_write",
  description:
    "Create or update an interactive Canvas Page (a self-contained HTML document with inline <style>/<script>) that the user opens beside the chat. It runs in a locked sandbox: no network (no fetch/XHR/CDN), no external images/fonts (use inline SVG or data: URIs), no forms, no iframes, no storage. Pass id to add a new version of an existing canvas. Requires the user's approval.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "Short page title.", maxLength: 120 },
      html: { type: "string", description: "Full HTML document or body fragment, inline CSS/JS only.", maxLength: MAX_HTML },
      id: { type: "string", description: "Existing canvas id (c_…) to revise; omit to create a new one." },
      note: { type: "string", description: "One-line change note for this version.", maxLength: 200 },
    },
    required: ["title", "html"],
    additionalProperties: false,
  },
  risk: "write",
  needsApproval: true,
  timeoutMs: 10_000,
  maxOutput: 2_000,
  label: (args) => `Canvas · ${cleanTitle(args.title)}`,
  describe: (args) => ({
    tool: "canvas_write",
    summary: `${args.id ? `Cập nhật canvas ${args.id}` : "Tạo canvas mới"}: “${cleanTitle(args.title)}” (${Buffer.byteLength(args.html || "", "utf8")} byte HTML, chạy trong sandbox, không mạng)`,
    preview: (args.html || "").slice(0, 1500),
  }),
  check: async (args) => {
    if (!canvasOn()) return "Canvas đang tắt (SABLE_CANVAS=0).";
    if (args.id !== undefined && !validCanvasId(args.id)) return "id canvas không hợp lệ (dạng c_…).";
    const html = checkHtml(args.html);
    return html.ok ? null : html.error;
  },
  async run(args) {
    if (!canvasOn()) return { ok: false, output: "Canvas đang tắt (SABLE_CANVAS=0)." };
    const s = canvasStore();
    const res = args.id ? s.update(args.id, { title: args.title, html: args.html, note: args.note, by: "agent" }) : s.create({ title: args.title, html: args.html, note: args.note, by: "agent" });
    if (!res.ok) return { ok: false, output: res.error };
    const c = res.canvas;
    return {
      ok: true,
      output: `canvas id=${c.id} version=${c.version} title="${c.title}". The user can open it from Background → Canvas or the link /api/canvas/${c.id}/view (owner login required).`,
    };
  },
};
