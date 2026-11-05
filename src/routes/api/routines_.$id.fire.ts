import { createFileRoute } from "@tanstack/react-router";
import { jobService } from "@/server/jobs.server";
import { guarded, methodNotAllowed, readTextBody } from "@/server/http";
import { decideAs } from "@/server/audit.server";
import { MAX_EVENT_TEXT } from "@/lib/agent/jobs/triggers";

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

/** A JSON payload that tries to decide an approval ({approvalId, approve|decision} or type approval.response). */
function approvalAttempt(raw: string): { approvalId: string; approve: boolean } | null {
  if (!raw.trim().startsWith("{")) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const p = (v.payload && typeof v.payload === "object" ? v.payload : v) as Record<string, unknown>;
    const id = p.approvalId ?? v.approvalId;
    if (typeof id !== "string" && v.type !== "approval.response") return null;
    return { approvalId: typeof id === "string" ? id.slice(0, 120) : "", approve: p.approve === true || p.decision === "approve" };
  } catch {
    return null;
  }
}

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
          const read = await readTextBody(request, MAX_EVENT_TEXT);
          if (!read.ok)
            return Response.json({ message: read.status === 413 ? "Payload quá lớn (tối đa 8 KB)." : read.message }, { status: read.status });
          const raw = read.text;
          const { scheduler } = jobService();
          try {
            // W2c: a routine trigger can never answer an approval. An authenticated
            // approval attempt is refused by policy (403) and audited approval.denied_policy.
            const ask = approvalAttempt(raw);
            if (ask) {
              const routine = scheduler.verifyWebhook(ID_RE.test(id) ? id : "", secret);
              const out = decideAs(ask.approvalId, ask.approve, { kind: "trigger", id: `webhook:${routine.id}` }, { jobsOnly: true });
              return Response.json({ ok: false, message: out.ok ? "unexpected" : out.reason }, { status: out.ok ? 500 : out.status });
            }
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
