import { createFileRoute } from "@tanstack/react-router";
import { guarded, methodNotAllowed, readObjectBody } from "@/server/http";
import { audit } from "@/server/audit.server";
import { USER } from "@/lib/agent/audit/types";
import { desktopOn, desktopStatus, startDesktop, stopDesktop } from "@/server/desktop.server";

/**
 * W3 desktop (owner-only, behind the desk auth).
 * GET  /api/desktop                     status (+ noVNC view URL while running)
 * POST {action:"start", url?} | {action:"stop"}
 */
const NO_STORE = { "Cache-Control": "no-store" };
export const Route = createFileRoute("/api/desktop")({
  server: {
    handlers: {
      GET: () => guarded("GET /api/desktop", () => Response.json(desktopStatus(), { headers: NO_STORE })),
      POST: ({ request }) =>
        guarded("POST /api/desktop", async () => {
          const read = await readObjectBody(request, 8_000);
          if (!read.ok) return read.response;
          const b = read.body;
          if (b.action === "start") {
            if (!desktopOn()) return Response.json({ message: "Desktop đang tắt (SABLE_DESKTOP=0).", code: "disabled" }, { status: 403 });
            const url = typeof b.url === "string" ? b.url.slice(0, 2000) : undefined;
            try {
              const st = await startDesktop(url);
              audit({ type: "side_effect", initiator: USER, tool: "desktop.start", summary: "Xvfb :99 + Chrome", ok: true });
              return Response.json(st, { headers: NO_STORE });
            } catch (error) {
              return Response.json({ message: error instanceof Error ? error.message : String(error), status: desktopStatus() }, { status: 409, headers: NO_STORE });
            }
          }
          if (b.action === "stop") {
            const st = await stopDesktop();
            audit({ type: "side_effect", initiator: USER, tool: "desktop.stop", summary: "stopped by owner", ok: true });
            return Response.json(st, { headers: NO_STORE });
          }
          return Response.json({ message: "action phải là start | stop." }, { status: 400 });
        }),
      ANY: methodNotAllowed("GET, POST"),
    },
  },
});
