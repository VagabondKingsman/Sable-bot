import { createFileRoute } from "@tanstack/react-router";
import { guarded, methodNotAllowed, readObjectBody } from "@/server/http";
import { audit } from "@/server/audit.server";
import { USER } from "@/lib/agent/audit/types";
import { applyCode, cancelCode, codeOn, codeStatus, deleteCode, getTask, publicTask, rejectCode, startCode, validTaskId } from "@/server/code.server";

/**
 * W4 code worktree agent (owner-only, behind the desk auth; nothing in the background can call this).
 * GET  /api/code                status + task list     GET /api/code?id=<task>  one task (steps, test log, diff)
 * POST {action:"start", repo, goal, testCmd?, baseRef?} | {action:"cancel"|"apply"|"reject"|"delete", id}
 * apply = owner approval → local `git merge --no-ff` into the repo's current branch (never pushes; PR off, D6).
 */
const NO_STORE = { "Cache-Control": "no-store" };
export const Route = createFileRoute("/api/code")({
  server: {
    handlers: {
      GET: ({ request }) =>
        guarded("GET /api/code", () => {
          const id = new URL(request.url).searchParams.get("id");
          if (id) {
            const t = validTaskId(id) ? getTask(id) : null;
            if (!t) return Response.json({ message: "not found" }, { status: 404, headers: NO_STORE });
            return Response.json(publicTask(t), { headers: NO_STORE });
          }
          return Response.json(codeStatus(), { headers: NO_STORE });
        }),
      POST: ({ request }) =>
        guarded("POST /api/code", async () => {
          const read = await readObjectBody(request, 16_000);
          if (!read.ok) return read.response;
          const b = read.body;
          if (!codeOn() && b.action !== "cancel" && b.action !== "reject") return Response.json({ message: "Code agent đang tắt (SABLE_CODEAGENT=0).", code: "disabled" }, { status: 403 });
          if (b.action === "start") {
            const r = await startCode({ repo: b.repo, goal: typeof b.goal === "string" ? b.goal.slice(0, 4000) : "", testCmd: b.testCmd, baseRef: b.baseRef });
            if (!r.ok) return Response.json({ message: r.message }, { status: r.status, headers: NO_STORE });
            return Response.json(r.task, { headers: NO_STORE });
          }
          if (!validTaskId(b.id)) return Response.json({ message: "id required." }, { status: 400 });
          if (b.action === "apply" || b.action === "reject") {
            const r = b.action === "apply" ? await applyCode(b.id, USER) : await rejectCode(b.id);
            if (!r.ok) return Response.json({ message: r.message }, { status: r.status, headers: NO_STORE });
            return Response.json(r.task, { headers: NO_STORE });
          }
          if (b.action === "cancel" || b.action === "delete") {
            const ok = b.action === "cancel" ? cancelCode(b.id) : deleteCode(b.id);
            if (ok) audit({ type: "side_effect", initiator: USER, tool: `code.${b.action}`, summary: b.id, ok: true });
            return Response.json({ ok }, { status: ok ? 200 : 409, headers: NO_STORE });
          }
          return Response.json({ message: "action phải là start | cancel | apply | reject | delete." }, { status: 400 });
        }),
      ANY: methodNotAllowed("GET, POST"),
    },
  },
});
