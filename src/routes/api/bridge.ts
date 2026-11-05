import { createFileRoute } from "@tanstack/react-router";
import { guarded, methodNotAllowed, readObjectBody } from "@/server/http";
import { audit } from "@/server/audit.server";
import { USER } from "@/lib/agent/audit/types";
import { bridgeStatus, createHandoff, decideHandoff, pingMock, setBridgeSettings, setInboundState } from "@/server/bridge.server";

/**
 * W6 bridge panel API (owner web UI, behind desk auth + same-origin CSRF).
 * GET  /api/bridge  status (no secret values), recent handoffs + inbound
 * POST {action:"handoff", kind:"task"|"question"|"ping", title, text} → pending approval card (nothing sent)
 *      {action:"decide", id, approve:boolean} → owner approves (sends once) / rejects
 *      {action:"ping_mock"} → signed ping to an in-process 127.0.0.1 mock peer (self-test)
 *      {action:"inbound", id, state:"resolved"|"dismissed"|"open"}
 *      {action:"settings", inboundThreads:boolean}
 */
const NO_STORE = { "Cache-Control": "no-store" };
const bad = (message: string, status = 400) => Response.json({ message }, { status, headers: NO_STORE });
export const Route = createFileRoute("/api/bridge")({
  server: {
    handlers: {
      GET: () => guarded("GET /api/bridge", () => Response.json(bridgeStatus(), { headers: NO_STORE })),
      POST: ({ request }) =>
        guarded("POST /api/bridge", async () => {
          const read = await readObjectBody(request, 260_000);
          if (!read.ok) return read.response;
          const b = read.body;
          switch (b.action) {
            case "handoff": {
              const r = createHandoff({ kind: b.kind, title: b.title, text: b.text }, USER);
              return r.ok ? Response.json({ ok: true, handoff: r.handoff }, { headers: NO_STORE }) : bad(r.error, r.status);
            }
            case "decide": {
              if (typeof b.id !== "string" || !/^brg_[a-z0-9_]{6,40}$/.test(b.id) || typeof b.approve !== "boolean") return bad("id + approve:boolean required");
              const r = await decideHandoff(b.id, b.approve, USER);
              return r.ok ? Response.json({ ok: true, handoff: r.handoff }, { headers: NO_STORE }) : bad(r.error, r.status);
            }
            case "ping_mock": {
              const r = await pingMock();
              audit({ type: "side_effect", initiator: USER, tool: "bridge.ping_mock", risk: "read", summary: `mock ping → ${r.status}`, ok: r.ok });
              return Response.json(r, { headers: NO_STORE });
            }
            case "inbound": {
              if (typeof b.id !== "string" || b.id.length > 80 || !["resolved", "dismissed", "open"].includes(String(b.state))) return bad("id + state required");
              const r = setInboundState(b.id, b.state as never);
              if (!r) return bad("not found", 404);
              audit({ type: "side_effect", initiator: USER, tool: "bridge.inbound_state", summary: `${b.id} → ${b.state}`, ok: true });
              return Response.json({ ok: true, item: r }, { headers: NO_STORE });
            }
            case "settings": {
              if (typeof b.inboundThreads !== "boolean") return bad("inboundThreads:boolean required");
              const s = setBridgeSettings({ inboundThreads: b.inboundThreads });
              audit({ type: "side_effect", initiator: USER, tool: "bridge.settings", summary: `inboundThreads=${s.inboundThreads}`, ok: true });
              return Response.json({ ok: true, settings: s }, { headers: NO_STORE });
            }
            default:
              return bad("unknown action");
          }
        }),
      ANY: methodNotAllowed("GET, POST"),
    },
  },
});
