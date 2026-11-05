import { createFileRoute } from "@tanstack/react-router";
import { guarded, methodNotAllowed, readObjectBody } from "@/server/http";
import { audit } from "@/server/audit.server";
import { USER } from "@/lib/agent/audit/types";
import { cancelRun, decideDesktop, takeShot, desktopOn, desktopStatus, startDesktop, startRun, stopDesktop } from "@/server/desktop.server";

/**
 * W3 desktop (owner-only, behind the desk auth).
 * GET  /api/desktop                     status (+ noVNC view URL while running)
 * POST {action:"start", url?} | {action:"stop"} | {action:"run", goal} | {action:"cancel"} | {action:"screenshot"}
 *      | {action:"decide", id, approve}   (owner web decision on a desktop approval card)
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
          if (b.action === "run") {
            const goal = typeof b.goal === "string" ? b.goal.trim() : "";
            if (!goal) return Response.json({ message: "Cần mục tiêu (goal)." }, { status: 400 });
            const r = await startRun(goal);
            if (!r.ok) return Response.json({ message: r.message }, { status: r.status, headers: NO_STORE });
            return Response.json(desktopStatus(), { headers: NO_STORE });
          }
          if (b.action === "screenshot") {
            // Read-only: no approval (D2). Only while the session runs.
            if (desktopStatus().state !== "running") return Response.json({ message: "Desktop chưa chạy." }, { status: 409 });
            const shot = await takeShot();
            return Response.json({ id: shot.id, url: shot.url }, { headers: NO_STORE });
          }
          if (b.action === "cancel") {
            const ok = cancelRun();
            return Response.json({ ok, ...desktopStatus() }, { headers: NO_STORE });
          }
          if (b.action === "decide") {
            if (typeof b.id !== "string" || typeof b.approve !== "boolean") return Response.json({ message: "id + approve required." }, { status: 400 });
            const r = decideDesktop(b.id.slice(0, 100), b.approve);
            if (!r.ok) return Response.json({ message: r.reason }, { status: r.status, headers: NO_STORE });
            return Response.json(desktopStatus(), { headers: NO_STORE });
          }
          if (b.action === "stop") {
            cancelRun();
            const st = await stopDesktop();
            audit({ type: "side_effect", initiator: USER, tool: "desktop.stop", summary: "stopped by owner", ok: true });
            return Response.json(st, { headers: NO_STORE });
          }
          return Response.json({ message: "action phải là start | stop | run | cancel | decide | screenshot." }, { status: 400 });
        }),
      ANY: methodNotAllowed("GET, POST"),
    },
  },
});
