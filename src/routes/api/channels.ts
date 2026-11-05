import { createFileRoute } from "@tanstack/react-router";
import { guarded, methodNotAllowed } from "@/server/http";
import { channelStatus } from "@/server/channels.server";

/** Read-only channel status (never tokens, passwords or full addresses). */
export const Route = createFileRoute("/api/channels")({
  server: {
    handlers: {
      GET: () => guarded("GET /api/channels", () => Response.json(channelStatus(), { headers: { "Cache-Control": "no-store" } })),
      ANY: methodNotAllowed("GET"),
    },
  },
});
