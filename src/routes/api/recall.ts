import { createFileRoute } from "@tanstack/react-router";
import { guarded, methodNotAllowed } from "@/server/http";
import { hybridSearch, vectorOn, vectorStatus } from "@/server/vector.server";
import { SOURCE_KINDS, type SourceKind } from "@/lib/agent/vector/store";

/**
 * W5 hybrid recall search for the Memory search panel (owner-only, read-only, behind desk auth).
 * GET /api/recall?q=…&sources=thread,canvas&mode=hybrid|bm25|vector&k=10
 */
const NO_STORE = { "Cache-Control": "no-store" };
export const Route = createFileRoute("/api/recall")({
  server: {
    handlers: {
      GET: ({ request }) =>
        guarded("GET /api/recall", async () => {
          const u = new URL(request.url).searchParams;
          const q = (u.get("q") ?? "").slice(0, 300);
          if (!vectorOn()) return Response.json({ enabled: false, hits: [] }, { headers: NO_STORE });
          const sources = (u.get("sources") ?? "").split(",").filter((s): s is SourceKind => (SOURCE_KINDS as readonly string[]).includes(s));
          const m = u.get("mode");
          const mode = m === "bm25" || m === "vector" ? m : "hybrid";
          const k = Math.min(30, Math.max(1, Number(u.get("k")) || 10));
          const t0 = Date.now();
          const hits = q.trim() ? await hybridSearch(q, { k, sources, mode }) : [];
          return Response.json(
            {
              enabled: true,
              embedder: vectorStatus().embedder,
              mode,
              ms: Date.now() - t0,
              hits: hits.map((h) => ({ id: h.chunk.id, source: h.chunk.source, title: h.chunk.title, ref: h.chunk.ref, at: h.chunk.at, text: h.chunk.text.slice(0, 1200), score: h.score, parts: h.parts })),
            },
            { headers: NO_STORE },
          );
        }),
      ANY: methodNotAllowed("GET"),
    },
  },
});
