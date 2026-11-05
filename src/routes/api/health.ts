import { createFileRoute } from "@tanstack/react-router";
import { guarded, methodNotAllowed } from "@/server/http";
import { dataDir } from "@/server/paths";
import { healthSnapshot, tickHeartbeat } from "@/lib/agent/resilience/heartbeat";

/**
 * Liveness + suspend/wake heartbeat. Watchdog and operators ping this.
 * POST ticks the heartbeat (used after resume / by watchdog).
 */
export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: () =>
        guarded("GET /api/health", () => {
          return Response.json(healthSnapshot(dataDir()), { headers: { "Cache-Control": "no-store" } });
        }),
      POST: () =>
        guarded("POST /api/health", () => {
          const beat = tickHeartbeat(dataDir());
          return Response.json(
            { ...healthSnapshot(dataDir()), tick: beat },
            { headers: { "Cache-Control": "no-store" } },
          );
        }),
      ANY: methodNotAllowed("GET, POST"),
    },
  },
});
