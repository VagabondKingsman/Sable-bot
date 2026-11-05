import { createFileRoute } from "@tanstack/react-router";
import { createJob, jobService, jobsOverview, jobView } from "@/server/jobs.server";
import { guarded, methodNotAllowed, readObjectBody } from "@/server/http";
import { isActive } from "@/lib/agent/jobs/types";

const MAX_BODY = 1_500_000;
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const notFound = () => Response.json({ message: "Không tìm thấy việc nền." }, { status: 404 });

/**
 * Background jobs. GET → list (or ?id= for one job with its trace).
 * POST { action: "create", request: ChatRequest, title? } | { action: "cancel" | "delete", id }.
 */
export const Route = createFileRoute("/api/jobs")({
  server: {
    handlers: {
      GET: ({ request }) =>
        guarded("GET /api/jobs", () => {
          const params = new URL(request.url).searchParams;
          if (params.get("counts") === "1") {
            const { enabled, routinesEnabled, counts, unread } = jobsOverview();
            return Response.json({ enabled, routinesEnabled, counts, unread });
          }
          const id = params.get("id");
          if (id !== null) {
            if (!ID_RE.test(id)) return notFound();
            const job = jobView(id);
            return job ? Response.json(job) : notFound();
          }
          return Response.json(jobsOverview());
        }),
      POST: ({ request }) =>
        guarded("POST /api/jobs", async () => {
          const read = await readObjectBody(request, MAX_BODY);
          if (!read.ok) return read.response;
          const body = read.body;
          const { runner, db } = jobService();
          if (body.action === "create") {
            if (body.title !== undefined && typeof body.title !== "string")
              return Response.json({ message: "Tiêu đề không hợp lệ." }, { status: 400 });
            const made = createJob(body.request, body.title);
            if (!made.ok) return Response.json({ message: made.message }, { status: made.status });
            return Response.json({ id: made.job.id }, { status: 201 });
          }
          if (body.action !== "cancel" && body.action !== "delete")
            return Response.json({ message: "Thao tác không hợp lệ." }, { status: 400 });
          if (typeof body.id !== "string" || !body.id)
            return Response.json({ message: "Thiếu id." }, { status: 400 });
          const job = ID_RE.test(body.id) ? db.getJob(body.id) : undefined;
          if (!job) return notFound();
          if (body.action === "cancel") {
            return runner.cancel(body.id)
              ? Response.json({ ok: true })
              : Response.json({ message: "Việc này đã xong, không hủy được nữa." }, { status: 409 });
          }
          if (isActive(job.status))
            return Response.json({ message: "Hủy việc trước khi xóa." }, { status: 409 });
          db.deleteJob(body.id);
          return Response.json({ ok: true });
        }),
      ANY: methodNotAllowed("GET, POST"),
    },
  },
});
