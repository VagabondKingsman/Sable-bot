import { createFileRoute } from "@tanstack/react-router";
import { jobService } from "@/server/jobs.server";
import { guarded, methodNotAllowed } from "@/server/http";
import { MAX_EVENT_TEXT } from "@/lib/agent/jobs/triggers";

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * Webhook trigger: POST /api/routines/<id>/fire with header X-Sable-Secret: <secret>.
 * Body (optional, ≤8 KB, any text/JSON) is passed to the run as untrusted event data.
 * Still behind the ngrok basic auth. 401 wrong secret / no webhook, 409 off / paused / busy,
 * 429 under 10 s since the last fire, 413 body too large.
 */
export const Route = createFileRoute("/api/routines_/$id/fire")({
  server: {
    handlers: {
      POST: ({ request, params }) =>
        guarded("POST /api/routines/$id/fire", async () => {
          const id = String(params.id ?? "");
          const secret = request.headers.get("x-sable-secret");
          const declared = Number(request.headers.get("content-length") || 0);
          if (declared > MAX_EVENT_TEXT) return Response.json({ message: "Payload quá lớn (tối đa 8 KB)." }, { status: 413 });
          const raw = request.body ? await request.text() : "";
          if (raw.length > MAX_EVENT_TEXT) return Response.json({ message: "Payload quá lớn (tối đa 8 KB)." }, { status: 413 });
          const { scheduler } = jobService();
          try {
            const job = scheduler.fireWebhook(ID_RE.test(id) ? id : "", secret, raw);
            return Response.json({ ok: true, jobId: job.id }, { status: 202 });
          } catch (error) {
            const status = (error as { status?: number }).status;
            if (error instanceof Error && typeof status === "number")
              return Response.json({ message: error.message }, { status });
            throw error;
          }
        }),
      ANY: methodNotAllowed("POST"),
    },
  },
});
