import { createFileRoute } from "@tanstack/react-router";
import { guarded, methodNotAllowed } from "@/server/http";
import { exportTraceById, getTrace, traceEnabled } from "@/server/trace.server";
import { validTraceId } from "@/lib/agent/trace/build";

/**
 * GET /api/traces/<id>            full timeline (optional ?tool=<name> filter)
 * GET /api/traces/<id>?export=1   download as sable.trace.v1 JSON
 */
export const Route = createFileRoute("/api/traces_/$id")({
  server: {
    handlers: {
      GET: ({ request, params }) =>
        guarded("GET /api/traces/$id", () => {
          if (!traceEnabled()) return Response.json({ message: "Trace đang tắt (SABLE_TRACE=0)." }, { status: 403 });
          const id = String(params.id ?? "");
          if (!validTraceId(id)) return Response.json({ message: "Mã trace không hợp lệ." }, { status: 400 });
          const url = new URL(request.url);
          if (url.searchParams.get("export") === "1") {
            const doc = exportTraceById(id);
            if (!doc) return Response.json({ message: "Không tìm thấy trace." }, { status: 404 });
            return new Response(JSON.stringify(doc, null, 2), {
              headers: {
                "Content-Type": "application/json; charset=utf-8",
                "Content-Disposition": `attachment; filename="sable-trace-${id}.json"`,
                "Cache-Control": "no-store",
              },
            });
          }
          const trace = getTrace(id, { tool: url.searchParams.get("tool") });
          if (!trace) return Response.json({ message: "Không tìm thấy trace." }, { status: 404 });
          return Response.json({ trace }, { headers: { "Cache-Control": "no-store" } });
        }),
      ANY: methodNotAllowed("GET"),
    },
  },
});
