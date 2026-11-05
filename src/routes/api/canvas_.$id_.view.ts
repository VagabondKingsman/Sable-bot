import { createFileRoute } from "@tanstack/react-router";
import { guarded, methodNotAllowed } from "@/server/http";
import { canvasOn, canvasStore } from "@/lib/agent/tools/canvas";
import { validCanvasId } from "@/lib/agent/canvas/store";
import { canvasHeaders, renderCanvasDocument } from "@/lib/agent/canvas/render";

/**
 * GET /api/canvas/<id>/view[?v=<n>] — the rendered page. This is also the share
 * link: it sits behind the desk's owner auth (ngrok basic-auth) like every other
 * route, and its CSP carries `sandbox allow-scripts`, so even a direct visit runs
 * in an opaque origin with no network.
 */
export const Route = createFileRoute("/api/canvas_/$id_/view")({
  server: {
    handlers: {
      GET: ({ request, params }) =>
        guarded("GET /api/canvas/$id/view", () => {
          if (!canvasOn()) return new Response("Canvas đang tắt (SABLE_CANVAS=0).", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } });
          const id = String(params.id ?? "");
          if (!validCanvasId(id)) return new Response("Mã canvas không hợp lệ.", { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });
          const v = Number(new URL(request.url).searchParams.get("v") ?? 0);
          const canvas = canvasStore().get(id, Number.isInteger(v) && v > 0 ? v : null);
          if (!canvas) return new Response("Không tìm thấy canvas.", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
          return new Response(renderCanvasDocument(canvas.html, canvas.title), { headers: canvasHeaders() });
        }),
      ANY: methodNotAllowed("GET"),
    },
  },
});
