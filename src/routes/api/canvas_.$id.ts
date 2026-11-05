import { createFileRoute } from "@tanstack/react-router";
import { guarded, methodNotAllowed } from "@/server/http";
import { canvasOn, canvasStore } from "@/lib/agent/tools/canvas";
import { validCanvasId } from "@/lib/agent/canvas/store";

/** GET /api/canvas/<id>[?v=<n>] — metadata, version list and the source of one version. */
export const Route = createFileRoute("/api/canvas_/$id")({
  server: {
    handlers: {
      GET: ({ request, params }) =>
        guarded("GET /api/canvas/$id", () => {
          if (!canvasOn()) return Response.json({ message: "Canvas đang tắt (SABLE_CANVAS=0)." }, { status: 403 });
          const id = String(params.id ?? "");
          if (!validCanvasId(id)) return Response.json({ message: "Mã canvas không hợp lệ." }, { status: 400 });
          const v = Number(new URL(request.url).searchParams.get("v") ?? 0);
          const canvas = canvasStore().get(id, Number.isInteger(v) && v > 0 ? v : null);
          if (!canvas) return Response.json({ message: "Không tìm thấy canvas / phiên bản." }, { status: 404 });
          return Response.json({ canvas }, { headers: { "Cache-Control": "no-store" } });
        }),
      ANY: methodNotAllowed("GET"),
    },
  },
});
