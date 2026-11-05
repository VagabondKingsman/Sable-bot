import { createFileRoute } from "@tanstack/react-router";
import { pickModel, readRouterConfig } from "@/lib/agent/budget/router";
import { guarded, methodNotAllowed } from "@/server/http";
import { plannerBundle } from "@/server/planner.server";

export const Route = createFileRoute("/api/budget")({
  server: {
    handlers: {
      GET: ({ request }) =>
        guarded("GET /api/budget", () => {
          const url = new URL(request.url);
          const scope = url.searchParams.get("scope");
          const scopeId = url.searchParams.get("scopeId") ?? undefined;
          const { budget } = plannerBundle();
          const totals =
            scope === "chat" || scope === "job" || scope === "plan"
              ? budget.totals(scope, scopeId)
              : budget.totals(undefined, scopeId);
          return Response.json(
            {
              enforce: budget.enforceOn(),
              caps: budget.caps(),
              totals,
              router: readRouterConfig(),
              pick: {
                hard: pickModel("hard"),
                light: pickModel("light"),
              },
            },
            { headers: { "Cache-Control": "no-store" } },
          );
        }),
      ANY: methodNotAllowed("GET"),
    },
  },
});
