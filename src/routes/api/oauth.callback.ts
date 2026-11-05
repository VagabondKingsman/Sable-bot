import { createFileRoute } from "@tanstack/react-router";
import { guarded, methodNotAllowed } from "@/server/http";
import { oauthManager, oauthOn } from "@/server/oauth.server";
import { OAuthError } from "@/lib/agent/oauth/types";
import { audit } from "@/server/audit.server";
import { USER } from "@/lib/agent/audit/types";

const HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  // The URL carries the one-time code: never leak it via Referer, never run scripts.
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
  "X-Content-Type-Options": "nosniff",
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (title: string, text: string, status: number) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><body style="font-family:system-ui;padding:2rem"><h1 style="font-size:1.2rem">${esc(title)}</h1><p>${esc(text)}</p><p><a href="/">← Về Sable</a></p></body>`,
    { status, headers: HEADERS },
  );

/** OAuth redirect target (register `<public origin>/api/oauth/callback` at the provider). */
export const Route = createFileRoute("/api/oauth/callback")({
  server: {
    handlers: {
      GET: ({ request }) =>
        guarded("GET /api/oauth/callback", async () => {
          if (!oauthOn()) return page("OAuth đang tắt", "SABLE_OAUTH=0.", 403);
          const q = new URL(request.url).searchParams;
          try {
            const { connectorId } = await oauthManager().complete({ state: q.get("state"), code: q.get("code"), error: q.get("error") });
            audit({ type: "side_effect", initiator: USER, tool: "oauth.connected", summary: `${connectorId}: connected`, ok: true });
            return page("Đã kết nối", `${oauthManager().connector(connectorId).label} đã kết nối. Bạn có thể đóng tab này.`, 200);
          } catch (error) {
            if (error instanceof OAuthError) {
              audit({ type: "side_effect", initiator: USER, tool: "oauth.connected", summary: `callback failed: ${error.code}`, ok: false });
              return page("Kết nối thất bại", error.message, 400);
            }
            throw error;
          }
        }),
      ANY: methodNotAllowed("GET"),
    },
  },
});
