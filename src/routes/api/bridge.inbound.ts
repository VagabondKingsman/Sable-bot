import { createFileRoute } from "@tanstack/react-router";
import { guarded, methodNotAllowed, readTextBody } from "@/server/http";
import { MAX_BODY, H_NONCE, H_SIG, H_TS, signedHeaders } from "@/lib/agent/bridge/protocol";
import { bridgeCfg, bridgeInbound } from "@/server/bridge.server";

/**
 * W6 inbound bridge: POST /api/bridge/inbound (machine endpoint; HMAC-authenticated, CSRF-exempt).
 * Headers X-Bridge-Signature: v1=<hex>, X-Bridge-Timestamp, X-Bridge-Nonce — see docs/BRIDGE-PROTOCOL.md.
 * Content is stored as untrusted data only (Tasks inbox, optional new thread); it never runs anything.
 */
export const Route = createFileRoute("/api/bridge/inbound")({
  server: {
    handlers: {
      POST: ({ request }) =>
        guarded("POST /api/bridge/inbound", async () => {
          const read = await readTextBody(request, MAX_BODY);
          if (!read.ok) return Response.json({ ok: false, code: read.status === 413 ? "too_large" : "bad_request", message: read.message }, { status: read.status });
          const out = bridgeInbound(read.text, { sig: request.headers.get(H_SIG), ts: request.headers.get(H_TS), nonce: request.headers.get(H_NONCE) });
          if ("reply" in out && out.reply) {
            const body = JSON.stringify(out.reply);
            const secret = bridgeCfg().secret;
            return new Response(body, { status: 200, headers: { ...(secret ? signedHeaders(secret, body) : { "content-type": "application/json" }), "cache-control": "no-store" } });
          }
          return Response.json(out.body, { status: out.status, headers: { "cache-control": "no-store" } });
        }),
      ANY: methodNotAllowed("POST"),
    },
  },
});
