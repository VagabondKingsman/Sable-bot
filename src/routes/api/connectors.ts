import { createFileRoute } from "@tanstack/react-router";
import { guarded, methodNotAllowed, readObjectBody } from "@/server/http";
import { connectorsView, oauthManager, oauthOn } from "@/server/oauth.server";
import { OAuthError } from "@/lib/agent/oauth/types";
import { audit } from "@/server/audit.server";
import { USER } from "@/lib/agent/audit/types";

/**
 * W2b connector registry (owner-only, behind the app's auth). GET → status of
 * each connector (never a token or client secret). POST {action:"connect",id}
 * → {url} to open; {action:"disconnect",id} → revoke + delete from vault;
 * {action:"sync",id:"gmail"} → pull new mail into triage now.
 */
export const Route = createFileRoute("/api/connectors")({
  server: {
    handlers: {
      GET: () => guarded("GET /api/connectors", () => Response.json(connectorsView(), { headers: { "Cache-Control": "no-store" } })),
      POST: ({ request }) =>
        guarded("POST /api/connectors", async () => {
          const read = await readObjectBody(request, 4_000);
          if (!read.ok) return read.response;
          const { action, id } = read.body;
          if (!oauthOn()) return Response.json({ message: "OAuth đang tắt (SABLE_OAUTH=0)." }, { status: 403 });
          if (typeof id !== "string" || !/^[a-z]{2,20}$/.test(id)) return Response.json({ message: "Thiếu id." }, { status: 400 });
          const mgr = oauthManager();
          try {
            mgr.connector(id);
          } catch {
            return Response.json({ message: "Không có connector này." }, { status: 404 });
          }
          try {
            if (action === "connect") {
              const { url } = mgr.begin(id);
              audit({ type: "side_effect", initiator: USER, tool: "oauth.connect", summary: `${id}: authorize started`, ok: true });
              return Response.json({ ok: true, url, ...connectorsView() }, { headers: { "Cache-Control": "no-store" } });
            }
            if (action === "disconnect") {
              const r = await mgr.revoke(id);
              audit({ type: "side_effect", initiator: USER, tool: "oauth.disconnect", summary: `${id}: revoked=${r.revoked} removed=${r.removed}`, ok: true });
              return Response.json({ ok: true, ...r, ...connectorsView() });
            }
            if (action === "sync") {
              const { syncConnector } = await import("@/server/connectors.server");
              const r = await syncConnector(id);
              return Response.json({ ok: true, ...r, ...connectorsView() });
            }
          } catch (error) {
            if (error instanceof OAuthError) {
              const status = error.code === "not_configured" ? 409 : error.code === "needs_auth" ? 409 : 400;
              return Response.json({ message: error.message, code: error.code, ...connectorsView() }, { status });
            }
            throw error;
          }
          return Response.json({ message: "action ∈ connect | disconnect | sync" }, { status: 400 });
        }),
      ANY: methodNotAllowed("GET, POST"),
    },
  },
});
