import { createFileRoute } from "@tanstack/react-router";
import { guarded, methodNotAllowed, readObjectBody } from "@/server/http";
import { audit } from "@/server/audit.server";
import { USER } from "@/lib/agent/audit/types";
import { cancelResearch, deleteResearch, getRun, publicRun, researchOn, researchStatus, startResearch, validRunId } from "@/server/research.server";

/**
 * W4 deep research (owner-only, behind the desk auth; nothing in the background can call this).
 * GET  /api/research            status + run list      GET /api/research?id=<run>  one run (checkpoints, sources, report)
 * POST {action:"start", question} | {action:"resume", id} | {action:"cancel", id} | {action:"delete", id}
 */
const NO_STORE = { "Cache-Control": "no-store" };
export const Route = createFileRoute("/api/research")({
  server: {
    handlers: {
      GET: ({ request }) =>
        guarded("GET /api/research", () => {
          const id = new URL(request.url).searchParams.get("id");
          if (id) {
            const r = validRunId(id) ? getRun(id) : null;
            if (!r) return Response.json({ message: "not found" }, { status: 404, headers: NO_STORE });
            return Response.json(publicRun(r), { headers: NO_STORE });
          }
          return Response.json(researchStatus(), { headers: NO_STORE });
        }),
      POST: ({ request }) =>
        guarded("POST /api/research", async () => {
          const read = await readObjectBody(request, 8_000);
          if (!read.ok) return read.response;
          const b = read.body;
          if (!researchOn() && b.action !== "cancel") return Response.json({ message: "Research đang tắt (SABLE_RESEARCH=0).", code: "disabled" }, { status: 403 });
          if (b.action === "start" || b.action === "resume") {
            const question = typeof b.question === "string" ? b.question.slice(0, 2000) : "";
            const id = b.action === "resume" ? (validRunId(b.id) ? b.id : null) : undefined;
            if (id === null) return Response.json({ message: "id required." }, { status: 400 });
            const r = await startResearch(question, id);
            if (!r.ok) return Response.json({ message: r.message }, { status: r.status, headers: NO_STORE });
            return Response.json(r.run, { headers: NO_STORE });
          }
          if (b.action === "cancel" || b.action === "delete") {
            if (!validRunId(b.id)) return Response.json({ message: "id required." }, { status: 400 });
            const ok = b.action === "cancel" ? cancelResearch(b.id) : deleteResearch(b.id);
            if (ok) audit({ type: "side_effect", initiator: USER, tool: `research.${b.action}`, summary: b.id, ok: true });
            return Response.json({ ok }, { status: ok ? 200 : 409, headers: NO_STORE });
          }
          return Response.json({ message: "action phải là start | resume | cancel | delete." }, { status: 400 });
        }),
      ANY: methodNotAllowed("GET, POST"),
    },
  },
});
