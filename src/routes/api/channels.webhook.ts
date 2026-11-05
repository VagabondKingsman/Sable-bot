import { createFileRoute } from "@tanstack/react-router";
import { getWebhookChannel } from "@/server/channels.server";
import { guarded, methodNotAllowed, readTextBody } from "@/server/http";
import { MAX_BODY } from "@/lib/agent/channels/webhook";

/**
 * Inbound webhook: POST /api/channels/webhook
 * Headers: X-Sable-Signature: sha256=<hmac-sha256-hex of raw body>
 * Body: versioned WebhookEvent JSON (see docs/WEBHOOK-API.md).
 * Still behind ngrok basic auth when exposed.
 */
export const Route = createFileRoute("/api/channels/webhook")({
  server: {
    handlers: {
      POST: ({ request }) =>
        guarded("POST /api/channels/webhook", async () => {
          // W2c: streaming cap (no unbounded request.text()).
          const read = await readTextBody(request, MAX_BODY);
          if (!read.ok) return Response.json({ message: read.status === 413 ? "Body quá lớn." : read.message }, { status: read.status });
          const raw = read.text;
          const wh = getWebhookChannel();
          if (!wh) return Response.json({ message: "Webhook chưa cấu hình (SABLE_WEBHOOK_SECRET)." }, { status: 409 });
          const sig = request.headers.get("x-sable-signature") || request.headers.get("X-Sable-Signature");
          const out = await wh.handleInbound(raw, sig);
          return Response.json(out.body, { status: out.status, headers: { "cache-control": "no-store" } });
        }),
      ANY: methodNotAllowed("POST"),
    },
  },
});
