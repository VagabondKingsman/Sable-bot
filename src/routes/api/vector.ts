import { createFileRoute } from "@tanstack/react-router";
import { guarded, methodNotAllowed, readObjectBody } from "@/server/http";
import { audit } from "@/server/audit.server";
import { USER } from "@/lib/agent/audit/types";
import { clearVector, syncVector, vectorOn, vectorStatus } from "@/server/vector.server";

/**
 * W5 local vector index (owner-only, behind the desk auth).
 * GET  /api/vector              status (embedder that ran, stats, last sync)
 * POST {action:"sync"} incremental reindex | {action:"rebuild"} clear + full reindex
 * Search is GET /api/recall (hybrid).
 */
const NO_STORE = { "Cache-Control": "no-store" };
export const Route = createFileRoute("/api/vector")({
  server: {
    handlers: {
      GET: () => guarded("GET /api/vector", () => Response.json(vectorStatus(), { headers: NO_STORE })),
      POST: ({ request }) =>
        guarded("POST /api/vector", async () => {
          const read = await readObjectBody(request, 2_000);
          if (!read.ok) return read.response;
          if (!vectorOn()) return Response.json({ message: "Chỉ mục vector đang tắt (SABLE_VECTOR=0).", code: "disabled" }, { status: 403 });
          const a = read.body.action;
          if (a !== "sync" && a !== "rebuild") return Response.json({ message: "action phải là sync | rebuild." }, { status: 400 });
          if (a === "rebuild") clearVector();
          const rep = await syncVector();
          audit({ type: "side_effect", initiator: USER, tool: `vector.${a}`, summary: rep ? `+${rep.added} ~${rep.updated} -${rep.removed}` : "failed", ok: Boolean(rep) });
          return Response.json({ report: rep, status: vectorStatus() }, { headers: NO_STORE });
        }),
      ANY: methodNotAllowed("GET, POST"),
    },
  },
});
