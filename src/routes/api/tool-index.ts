import { createFileRoute } from "@tanstack/react-router";
import { guarded, methodNotAllowed } from "@/server/http";
import { detectOs, proposeInstalls, scanTools, toolIndexOn } from "@/lib/agent/toolindex/scan";

/** Scan PATH for benign tools; propose install commands. Never auto-installs. */
export const Route = createFileRoute("/api/tool-index")({
  server: {
    handlers: {
      GET: () =>
        guarded("GET /api/tool-index", () => {
          if (!toolIndexOn()) return Response.json({ enabled: false, killed: true });
          const os = detectOs();
          const tools = scanTools(undefined, os);
          return Response.json({
            enabled: true,
            killed: false,
            os,
            tools,
            proposals: proposeInstalls(tools),
            note: "Install commands are proposals only — run only after explicit owner approval. No RE/pentest toolchains in this index. Auto-install disabled.",
          });
        }),
      ANY: methodNotAllowed("GET"),
    },
  },
});
