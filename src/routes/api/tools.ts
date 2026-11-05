import { createFileRoute } from "@tanstack/react-router";
import { decideAs } from "@/server/audit.server";
import { USER } from "@/lib/agent/audit/types";
import { guarded, methodNotAllowed, readObjectBody } from "@/server/http";

/** Approve or reject a pending write tool call (chat or background job): { id, approve }. */
export const Route = createFileRoute("/api/tools")({
  server: {
    handlers: {
      POST: ({ request }) =>
        guarded("POST /api/tools", async () => {
          const read = await readObjectBody(request, 10_000);
          if (!read.ok) return read.response;
          const body = read.body;
          if (typeof body.id !== "string" || !body.id || body.id.length > 100 || typeof body.approve !== "boolean") {
            return Response.json({ message: "Thiếu id hoặc approve." }, { status: 400 });
          }
          // Chat approvals first, then background-job approvals, then scope (same card, same endpoint).
          // The web UI is the owner: decider kind "user". Policy + audit in decideAs (W2a).
          const out = decideAs(body.id, body.approve, USER, { scope: body.kind === "scope" });
          if (!out.ok && out.status === 403) return Response.json({ message: `Không được duyệt: ${out.reason}` }, { status: 403 });
          if (!out.ok) return Response.json({ message: "Yêu cầu duyệt đã hết hạn hoặc không còn." }, { status: 404 });
          return Response.json({ ok: true });
        }),
      ANY: methodNotAllowed("POST"),
    },
  },
});
