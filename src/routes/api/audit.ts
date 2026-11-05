import { createFileRoute } from "@tanstack/react-router";
import { guarded, methodNotAllowed } from "@/server/http";
import { listAudit } from "@/server/audit.server";
import { isInitiatorKind, INITIATOR_KINDS, type AuditType } from "@/lib/agent/audit/types";

const TYPES: AuditType[] = ["side_effect", "approval.requested", "approval.decided", "approval.denied_policy", "brief.delivered"];

/**
 * W2a audit (read-only, owner-only). GET ?type=&kind=&jobId=&approvalId=&since=&limit=
 * → newest first. Each record carries initiator_kind / initiator_id and, for
 * decisions, decider_kind / decider_id.
 */
export const Route = createFileRoute("/api/audit")({
  server: {
    handlers: {
      GET: ({ request }) =>
        guarded("GET /api/audit", () => {
          const u = new URL(request.url).searchParams;
          const type = u.get("type");
          const kind = u.get("kind");
          if (type && !TYPES.includes(type as AuditType)) return Response.json({ message: `type ∈ ${TYPES.join(", ")}` }, { status: 400 });
          if (kind && !isInitiatorKind(kind)) return Response.json({ message: `kind ∈ ${INITIATOR_KINDS.join(", ")}` }, { status: 400 });
          const str = (k: string) => {
            const v = u.get(k);
            return v && v.length <= 120 ? v : undefined;
          };
          const items = listAudit({
            type: (type as AuditType) || undefined,
            kind: kind && isInitiatorKind(kind) ? kind : undefined,
            jobId: str("jobId"),
            approvalId: str("approvalId"),
            since: Number(u.get("since")) || undefined,
            limit: Number(u.get("limit")) || 200,
          });
          return Response.json({ items, kinds: INITIATOR_KINDS, types: TYPES }, { headers: { "Cache-Control": "no-store" } });
        }),
      ANY: methodNotAllowed("GET"),
    },
  },
});
