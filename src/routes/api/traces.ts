import { createFileRoute } from "@tanstack/react-router";
import { guarded, methodNotAllowed } from "@/server/http";
import { listTraces, traceEnabled } from "@/server/trace.server";

/** GET /api/traces?source=chat|job|plan&tool=<name>&q=<text>&limit=<n> — summaries, newest first. */
export const Route = createFileRoute("/api/traces")({
  server: {
    handlers: {
      GET: ({ request }) =>
        guarded("GET /api/traces", () => {
          if (!traceEnabled()) return Response.json({ enabled: false, items: [], tools: [], total: 0, message: "Trace đang tắt (SABLE_TRACE=0)." });
          const url = new URL(request.url);
          const limit = Number(url.searchParams.get("limit") ?? 100);
          return Response.json(
            listTraces({
              source: url.searchParams.get("source"),
              tool: url.searchParams.get("tool"),
              q: url.searchParams.get("q"),
              limit: Number.isFinite(limit) ? limit : 100,
            }),
            { headers: { "Cache-Control": "no-store" } },
          );
        }),
      ANY: methodNotAllowed("GET"),
    },
  },
});
