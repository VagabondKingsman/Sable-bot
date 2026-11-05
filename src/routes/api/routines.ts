import { createFileRoute } from "@tanstack/react-router";
import { jobConfig, jobService, routineView } from "@/server/jobs.server";
import { guarded, methodNotAllowed, readObjectBody } from "@/server/http";
import { parseRoutineInput, TriggerError } from "@/lib/agent/jobs/scheduler";

const MAX_BODY = 200_000;
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const notFound = () => Response.json({ message: "Không tìm thấy lịch chạy." }, { status: 404 });

/**
 * Routines (scheduled prompts). GET → list.
 * POST { action: "create", ...routine } | { action: "update", id, ...routine }
 *    | { action: "toggle", id, enabled } | { action: "delete" | "run", id }
 *    | { action: "webhook", id, on } → { secret } shown once (rotates on each call)
 *    | { action: "watch", id, watch: { url, everyMin } | null }.
 */
export const Route = createFileRoute("/api/routines")({
  server: {
    handlers: {
      GET: () =>
        guarded("GET /api/routines", () => {
          const { scheduler } = jobService();
          return Response.json({
            enabled: scheduler.enabled(),
            triggersEnabled: scheduler.triggersEnabled(),
            now: Date.now(),
            routines: scheduler.list().map(routineView),
          });
        }),
      POST: ({ request }) =>
        guarded("POST /api/routines", async () => {
          const read = await readObjectBody(request, MAX_BODY);
          if (!read.ok) return read.response;
          const body = read.body;
          const action = body.action;
          if (!["create", "update", "toggle", "delete", "run", "webhook", "watch"].includes(action as string))
            return Response.json({ message: "Thao tác không hợp lệ." }, { status: 400 });
          const { scheduler } = jobService();
          const cap = jobConfig().maxSteps;
          if (action !== "create") {
            if (typeof body.id !== "string" || !body.id)
              return Response.json({ message: "Thiếu id." }, { status: 400 });
            if (!ID_RE.test(body.id) || !scheduler.get(body.id)) return notFound();
          }
          const id = body.id as string;
          try {
            if (action === "create" || action === "update") {
              const parsed = parseRoutineInput(body, cap);
              if (!parsed.ok) return Response.json({ message: parsed.error }, { status: 400 });
              if (action === "create")
                return Response.json(routineView(scheduler.create(parsed.value)), { status: 201 });
              const updated = scheduler.update(id, parsed.value);
              return updated ? Response.json(routineView(updated)) : notFound();
            }
            if (action === "toggle") {
              if (typeof body.enabled !== "boolean")
                return Response.json({ message: "Thiếu enabled (true/false)." }, { status: 400 });
              const updated = scheduler.setEnabled(id, body.enabled);
              return updated ? Response.json(routineView(updated)) : notFound();
            }
            if (action === "webhook") {
              if (typeof body.on !== "boolean")
                return Response.json({ message: "Thiếu on (true/false)." }, { status: 400 });
              const out = scheduler.setWebhook(id, body.on);
              const routine = scheduler.get(id);
              return Response.json(
                { ...out, routine: routine ? routineView(routine) : null },
                { headers: { "cache-control": "no-store" } },
              );
            }
            if (action === "watch") {
              const updated = scheduler.setWatch(id, body.watch ?? null);
              return updated ? Response.json(routineView(updated)) : notFound();
            }
            if (action === "delete")
              return scheduler.remove(id) ? Response.json({ ok: true }) : notFound();
            const job = scheduler.runNow(id);
            return Response.json({ id: job.id }, { status: 201 });
          } catch (error) {
            if (error instanceof TriggerError)
              return Response.json({ message: error.message }, { status: error.status });
            // Expected refusals (limit reached, previous run active, kill switch).
            if (error instanceof Error && error.name === "RoutineRefusal")
              return Response.json({ message: error.message }, { status: 409 });
            throw error;
          }
        }),
      ANY: methodNotAllowed("GET, POST"),
    },
  },
});
