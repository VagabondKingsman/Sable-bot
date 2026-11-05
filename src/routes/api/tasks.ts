import { createFileRoute } from "@tanstack/react-router";
import { guarded, methodNotAllowed, readObjectBody } from "@/server/http";
import { plannerBundle } from "@/server/planner.server";
import { tasksInbox } from "@/server/proactive.server";
import { decideStepAs } from "@/server/audit.server";
import { USER } from "@/lib/agent/audit/types";
import type { StepKind } from "@/lib/agent/planner/types";

const MAX_BODY = 100_000;
const KINDS = new Set<StepKind>(["note", "classify", "agent", "write_gate", "doc_audit"]);

export const Route = createFileRoute("/api/tasks")({
  server: {
    handlers: {
      GET: ({ request }) =>
        guarded("GET /api/tasks", () => {
          const url = new URL(request.url);
          const id = url.searchParams.get("id");
          // W2a: one Tasks inbox (planner tasks + approvals + triaged items + active jobs).
          if (url.searchParams.get("view") === "inbox")
            return tasksInbox({ includeSnoozed: url.searchParams.get("snoozed") === "1" }).then((view) =>
              Response.json(view, { headers: { "Cache-Control": "no-store" } }),
            );
          const { plans, workspaces } = plannerBundle();
          if (id) {
            const plan = plans.get(id);
            if (!plan) return Response.json({ message: "Không tìm thấy task." }, { status: 404 });
            return Response.json(
              { plan, workspace: workspaces.info(plan.workspaceId), enabled: plans.enabled() },
              { headers: { "Cache-Control": "no-store" } },
            );
          }
          return Response.json(
            {
              enabled: plans.enabled(),
              items: plans.list().map((p) => ({
                id: p.id,
                goal: p.goal,
                status: p.status,
                stepCount: p.steps.length,
                currentStepId: p.currentStepId,
                usedTokens: p.usedTokens,
                usedUsd: p.usedUsd,
                updatedAt: p.updatedAt,
                workspaceId: p.workspaceId,
              })),
            },
            { headers: { "Cache-Control": "no-store" } },
          );
        }),
      POST: ({ request }) =>
        guarded("POST /api/tasks", async () => {
          const read = await readObjectBody(request, MAX_BODY);
          if (!read.ok) return read.response;
          const body = read.body;
          const { plans, executor, workspaces } = plannerBundle();
          const action = typeof body.action === "string" ? body.action : "create";

          if (action === "create") {
            if (typeof body.goal !== "string" || !Array.isArray(body.steps)) {
              return Response.json({ message: "Thiếu goal/steps." }, { status: 400 });
            }
            const steps = body.steps
              .filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === "object")
              .map((s) => {
                const difficulty = s.difficulty === "light" || s.difficulty === "hard" ? (s.difficulty as "light" | "hard") : undefined;
                return {
                  id: typeof s.id === "string" ? s.id : undefined,
                  title: typeof s.title === "string" ? s.title : "step",
                  kind: typeof s.kind === "string" && KINDS.has(s.kind as StepKind) ? (s.kind as StepKind) : undefined,
                  deps: Array.isArray(s.deps) ? s.deps.filter((d): d is string => typeof d === "string") : undefined,
                  difficulty,
                  requiresApproval: typeof s.requiresApproval === "boolean" ? s.requiresApproval : undefined,
                };
              });
            const created = plans.create({
              goal: body.goal,
              steps,
              maxSteps: typeof body.maxSteps === "number" ? body.maxSteps : undefined,
              timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : undefined,
              budgetTokens: typeof body.budgetTokens === "number" ? body.budgetTokens : undefined,
              budgetUsd: typeof body.budgetUsd === "number" ? body.budgetUsd : undefined,
              initiator: { kind: "user", id: "owner:web" },
            });
            if (!created.ok) return Response.json({ message: created.error }, { status: 400 });
            workspaces.ensure(created.plan.workspaceId);
            if (body.autostart !== false) {
              executor.start(created.plan.id);
              await executor.tick(created.plan.id);
            }
            const plan = plans.get(created.plan.id)!;
            return Response.json({ ok: true, plan, workspace: workspaces.info(plan.workspaceId) });
          }

          if (typeof body.id !== "string") return Response.json({ message: "Thiếu id." }, { status: 400 });
          const id = body.id;

          if (action === "tick") {
            const res = await executor.tick(id);
            if (!res.ok) return Response.json({ message: res.error, plan: plans.get(id) }, { status: 400 });
            return Response.json(res);
          }
          if (action === "pause") {
            const res = executor.pause(id);
            return res.ok ? Response.json(res) : Response.json({ message: res.error }, { status: 400 });
          }
          if (action === "resume") {
            const res = executor.resume(id);
            if (!res.ok) return Response.json({ message: res.error }, { status: 400 });
            const tick = await executor.tick(id);
            return Response.json(tick.ok ? tick : { ok: false, error: tick.error, plan: plans.get(id) });
          }
          if (action === "cancel") {
            const res = executor.cancel(id);
            return res.ok ? Response.json(res) : Response.json({ message: res.error }, { status: 400 });
          }
          if (action === "approve_step") {
            if (typeof body.stepId !== "string" || typeof body.approve !== "boolean") {
              return Response.json({ message: "Thiếu stepId/approve." }, { status: 400 });
            }
            const approve = body.approve;
            const stepId = body.stepId;
            const out = decideStepAs(id, stepId, approve, USER, () => executor.approveStep(id, stepId, approve));
            if (!out.ok) return Response.json({ message: out.reason }, { status: out.status === 403 ? 403 : 400 });
            if (body.approve) await executor.tick(id);
            return Response.json({ ok: true, plan: plans.get(id) });
          }
          if (action === "delete") {
            const plan = plans.get(id);
            if (plan) workspaces.wipe(plan.workspaceId);
            plans.delete(id);
            return Response.json({ ok: true });
          }
          return Response.json({ message: "action không hợp lệ." }, { status: 400 });
        }),
      ANY: methodNotAllowed("GET, POST"),
    },
  },
});
