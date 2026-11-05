import { createFileRoute } from "@tanstack/react-router";
import { sharedApprovals } from "@/lib/agent/tools/approvals";
import { jobService } from "@/server/jobs.server";
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
          // Chat approvals first, then background-job approvals (same card, same endpoint).
          const found =
            sharedApprovals().decide(body.id, body.approve) || jobService().runner.decide(body.id, body.approve);
          if (!found) return Response.json({ message: "Yêu cầu duyệt đã hết hạn hoặc không còn." }, { status: 404 });
          return Response.json({ ok: true });
        }),
      ANY: methodNotAllowed("POST"),
    },
  },
});
