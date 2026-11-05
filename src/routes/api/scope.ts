import { createFileRoute } from "@tanstack/react-router";
import { guarded, methodNotAllowed, readObjectBody } from "@/server/http";
import { assertReadyForAct, scopeAuditLine } from "@/lib/agent/scope/guard";
import { scopeKillDenyAll } from "@/lib/agent/scope/store";
import { scopeStore } from "@/server/scope.server";

const MAX_BODY = 20_000;

export const Route = createFileRoute("/api/scope")({
  server: {
    handlers: {
      GET: () =>
        guarded("GET /api/scope", () => {
          const store = scopeStore();
          store.refresh();
          return Response.json(
            {
              killDenyAll: scopeKillDenyAll(),
              items: store.list(),
            },
            { headers: { "Cache-Control": "no-store" } },
          );
        }),
      POST: ({ request }) =>
        guarded("POST /api/scope", async () => {
          const read = await readObjectBody(request, MAX_BODY);
          if (!read.ok) return read.response;
          const body = read.body;
          const store = scopeStore();
          if (body.action === "create") {
            if (typeof body.target !== "string" || typeof body.purpose !== "string")
              return Response.json({ message: "Thiếu target/purpose." }, { status: 400 });
            const rec = store.create({
              target: body.target,
              purpose: body.purpose,
              owner: typeof body.owner === "string" ? body.owner : "owner",
              ttlMs: typeof body.ttlMs === "number" ? body.ttlMs : undefined,
              networkProfile:
                body.networkProfile === "offline" ||
                body.networkProfile === "lab_only" ||
                body.networkProfile === "authorized_target_only"
                  ? body.networkProfile
                  : undefined,
              notes: typeof body.notes === "string" ? body.notes : undefined,
            });
            return Response.json({ ok: true, scope: rec, audit: scopeAuditLine({ ok: false, reason: "pending", scope: rec }, "create") });
          }
          if (body.action === "approve" || body.action === "deny") {
            if (typeof body.id !== "string") return Response.json({ message: "Thiếu id." }, { status: 400 });
            const rec = store.decide(body.id, body.action === "approve" ? "approved" : "denied", typeof body.approvalId === "string" ? body.approvalId : undefined);
            if (!rec) return Response.json({ message: "Không tìm thấy scope." }, { status: 404 });
            return Response.json({ ok: true, scope: rec });
          }
          if (body.action === "guard") {
            if (typeof body.id !== "string") return Response.json({ message: "Thiếu id." }, { status: 400 });
            const decision = assertReadyForAct(store, {
              scopeId: body.id,
              mode: body.mode === "background" ? "background" : "interactive",
              requiresScope: true,
            });
            return Response.json({
              ...decision,
              audit: scopeAuditLine(decision, typeof body.tool === "string" ? body.tool : "guard"),
            });
          }
          return Response.json({ message: "action không hợp lệ." }, { status: 400 });
        }),
      ANY: methodNotAllowed("GET, POST"),
    },
  },
});
