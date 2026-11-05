import { createFileRoute } from "@tanstack/react-router";
import { guarded, methodNotAllowed, readObjectBody } from "@/server/http";
import { briefOn, briefView, previewBrief, runBrief, updateBrief } from "@/server/proactive.server";

/**
 * Morning brief (W2a). GET → config + history (+ ?preview=1 composes now
 * without delivering). POST { action: "config", enabled?, time?, tz?, telegram? }
 * or { action: "run" } (deliver now to inbox / owner Telegram).
 */
export const Route = createFileRoute("/api/brief")({
  server: {
    handlers: {
      GET: ({ request }) =>
        guarded("GET /api/brief", async () => {
          const preview = new URL(request.url).searchParams.get("preview") === "1";
          return Response.json({ ...briefView(), preview: preview && briefOn() ? await previewBrief() : null }, { headers: { "Cache-Control": "no-store" } });
        }),
      POST: ({ request }) =>
        guarded("POST /api/brief", async () => {
          if (!briefOn()) return Response.json({ message: "Bản tin đang tắt (SABLE_BRIEF=0)." }, { status: 503 });
          const read = await readObjectBody(request, 10_000);
          if (!read.ok) return read.response;
          const b = read.body;
          if (b.action === "config") {
            try {
              const config = updateBrief({
                enabled: typeof b.enabled === "boolean" ? b.enabled : undefined,
                time: typeof b.time === "string" ? b.time : undefined,
                tz: typeof b.tz === "string" ? b.tz : undefined,
                telegram: typeof b.telegram === "boolean" ? b.telegram : undefined,
              });
              return Response.json({ ok: true, config });
            } catch (error) {
              return Response.json({ message: error instanceof Error ? error.message : "Cấu hình không hợp lệ." }, { status: 400 });
            }
          }
          if (b.action === "run") {
            const out = await runBrief({ manual: true });
            return out.ok ? Response.json(out) : Response.json({ message: out.error }, { status: 503 });
          }
          return Response.json({ message: "Thao tác không hợp lệ." }, { status: 400 });
        }),
      ANY: methodNotAllowed("GET, POST"),
    },
  },
});
