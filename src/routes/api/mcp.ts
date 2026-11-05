import { createFileRoute } from "@tanstack/react-router";
import { guarded, methodNotAllowed, readObjectBody } from "@/server/http";
import { deleteFileServer, mcpConfig, mcpManager, mcpOn, saveFileServer, toggleServer } from "@/server/mcp.server";

const NO_STORE = { "Cache-Control": "no-store" };

async function view() {
  const { errors } = mcpConfig();
  return { enabled: mcpOn(), errors, servers: mcpOn() ? mcpManager().status() : [] };
}

/**
 * MCP servers. GET → status (never header values). POST {action:"refresh"} |
 * {action:"save", server} (file config only) | {action:"delete", name} | {action:"toggle", name, enabled}.
 */
export const Route = createFileRoute("/api/mcp")({
  server: {
    handlers: {
      GET: () =>
        guarded("GET /api/mcp", async () => {
          if (mcpOn()) await mcpManager().refresh(false, 6_000);
          return Response.json(await view(), { headers: NO_STORE });
        }),
      POST: ({ request }) =>
        guarded("POST /api/mcp", async () => {
          if (!mcpOn()) return Response.json({ message: "MCP đang tắt (SABLE_MCP=0)." }, { status: 409 });
          const read = await readObjectBody(request, 32_000);
          if (!read.ok) return read.response;
          const b = read.body;
          const name = typeof b.name === "string" ? b.name : "";
          if (b.action === "refresh") {
            await mcpManager().refresh(true, 15_000);
          } else if (b.action === "save") {
            const err = saveFileServer(b.server);
            if (err) return Response.json({ message: err }, { status: 422 });
            await mcpManager().refresh(false, 12_000);
          } else if (b.action === "delete") {
            if (!deleteFileServer(name)) return Response.json({ message: "Không có máy chủ này trong mcp-servers.json." }, { status: 404 });
          } else if (b.action === "toggle") {
            if (!toggleServer(name, b.enabled === true)) return Response.json({ message: "Không có máy chủ này." }, { status: 404 });
            if (b.enabled === true) await mcpManager().refresh(false, 12_000);
          } else return Response.json({ message: "Hành động không hợp lệ." }, { status: 400 });
          return Response.json(await view(), { headers: NO_STORE });
        }),
      ANY: methodNotAllowed("GET, POST"),
    },
  },
});
