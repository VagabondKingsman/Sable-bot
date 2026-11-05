import { createFileRoute } from "@tanstack/react-router";
import crypto from "node:crypto";
import { guarded } from "@/server/http";
import { canvasOn, canvasStore } from "@/lib/agent/tools/canvas";
import { shareOn } from "@/lib/agent/canvas/shares";
import { canvasHeaders, GUARD_PARENT_JS, renderCanvasDocument } from "@/lib/agent/canvas/render";
import { shareStore } from "@/server/shares.server";

/**
 * W2c read-only share view.
 *   GET /s/<token>        wrapper page (its only script is a nonce'd navigation guard) embedding
 *   GET /s/<token>?raw=1  the canvas document in a sandboxed iframe (same CSP as the desk view).
 * Wrong, expired, revoked or disabled → one uniform 404. GET/HEAD only. Token never echoed in logs;
 * Referrer-Policy no-referrer so it cannot leak onward.
 */
const NOT_FOUND = () =>
  new Response("Không tìm thấy (link sai, đã hết hạn hoặc đã bị thu hồi).", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow" },
  });

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
const ictTime = (ms: number) => new Intl.DateTimeFormat("vi-VN", { timeZone: "Asia/Saigon", dateStyle: "short", timeStyle: "short" }).format(ms);

function view(request: Request, token: string) {
  if (!shareOn() || !canvasOn()) return NOT_FOUND();
  const raw = new URL(request.url).searchParams.get("raw") === "1";
  const share = shareStore().resolve(token, { count: !raw });
  if (!share) return NOT_FOUND();
  const canvas = canvasStore().get(share.canvasId, share.version);
  if (!canvas) return NOT_FOUND();
  if (raw) {
    const h = canvasHeaders();
    return new Response(renderCanvasDocument(canvas.html, canvas.title), { headers: { ...h, "X-Robots-Tag": "noindex, nofollow" } });
  }
  const nonce = crypto.randomBytes(16).toString("base64");
  const html = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(canvas.title)}</title>
<style>html,body{margin:0;height:100%;font-family:system-ui,sans-serif;background:#f4f4f5;color:#111}header{display:flex;gap:12px;align-items:baseline;padding:10px 16px;font-size:14px}header b{font-size:15px}small{color:#666}#nav{color:#b45309}iframe{display:block;border:0;width:100%;height:calc(100% - 44px);background:#fff}</style></head>
<body><header><b>${esc(canvas.title)}</b><small>Chỉ xem · hết hạn ${esc(ictTime(share.expiresAt))} (giờ VN)</small><small id="nav"></small></header>
<iframe id="cv" title="${esc(canvas.title)}" sandbox="allow-scripts" referrerpolicy="no-referrer" src="?raw=1"></iframe>
<script nonce="${nonce}">${GUARD_PARENT_JS}</script></body></html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; frame-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
}

export const Route = createFileRoute("/s/$token")({
  server: {
    handlers: {
      GET: ({ request, params }) => guarded("GET /s/$token", () => view(request, String(params.token ?? ""))),
      HEAD: ({ request, params }) => guarded("HEAD /s/$token", async () => {
        const r = view(request, String(params.token ?? ""));
        return new Response(null, { status: r.status, headers: r.headers });
      }),
      ANY: () => new Response("Chỉ xem.", { status: 405, headers: { allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" } }),
    },
  },
});
