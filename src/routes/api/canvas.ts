import { createFileRoute } from "@tanstack/react-router";
import { guarded, methodNotAllowed, readObjectBody } from "@/server/http";
import { canvasOn, canvasStore } from "@/lib/agent/tools/canvas";
import { MAX_HTML } from "@/lib/agent/canvas/store";

/**
 * GET  /api/canvas                              list (newest first)
 * POST {action:"create", title, html, note?}    new canvas (owner, via the authenticated desk)
 * POST {action:"update", id, html, title?, note?}  new version
 * POST {action:"delete", id}
 * Kill switch SABLE_CANVAS=0 → 403 (list reports enabled:false).
 */
export const Route = createFileRoute("/api/canvas")({
  server: {
    handlers: {
      GET: () =>
        guarded("GET /api/canvas", () => {
          if (!canvasOn()) return Response.json({ enabled: false, items: [], message: "Canvas đang tắt (SABLE_CANVAS=0)." });
          return Response.json({ enabled: true, items: canvasStore().list() }, { headers: { "Cache-Control": "no-store" } });
        }),
      POST: ({ request }) =>
        guarded("POST /api/canvas", async () => {
          if (!canvasOn()) return Response.json({ message: "Canvas đang tắt (SABLE_CANVAS=0).", code: "disabled" }, { status: 403 });
          const read = await readObjectBody(request, MAX_HTML + 16_000);
          if (!read.ok) return read.response;
          const body = read.body;
          const store = canvasStore();
          const note = typeof body.note === "string" ? body.note : undefined;
          if (body.action === "create") {
            const res = store.create({ title: body.title, html: body.html, note, by: "owner" });
            return res.ok ? Response.json({ canvas: res.canvas }, { status: 201 }) : Response.json({ message: res.error }, { status: 400 });
          }
          if (body.action === "update") {
            if (typeof body.id !== "string") return Response.json({ message: "Thiếu id." }, { status: 400 });
            const res = store.update(body.id, { title: body.title, html: body.html, note, by: "owner" });
            return res.ok ? Response.json({ canvas: res.canvas }) : Response.json({ message: res.error }, { status: res.error.includes("Không tìm thấy") ? 404 : 400 });
          }
          if (body.action === "delete") {
            if (typeof body.id !== "string") return Response.json({ message: "Thiếu id." }, { status: 400 });
            return store.remove(body.id) ? Response.json({ ok: true }) : Response.json({ message: "Không tìm thấy canvas." }, { status: 404 });
          }
          return Response.json({ message: "action phải là create | update | delete." }, { status: 400 });
        }),
      ANY: methodNotAllowed("GET, POST"),
    },
  },
});
