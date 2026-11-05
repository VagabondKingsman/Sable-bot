import path from "node:path";
import { createFileRoute } from "@tanstack/react-router";
import { guarded, methodNotAllowed, readObjectBody } from "@/server/http";
import { classify, loadRoutingConfig, routerOn } from "@/lib/agent/router/match";
import { skillsDir } from "@/server/skills.server";

const MAX_BODY = 8_000;

function configPath() {
  return path.join(skillsDir(), "routing.json");
}

export const Route = createFileRoute("/api/router")({
  server: {
    handlers: {
      GET: () =>
        guarded("GET /api/router", () => {
          const enabled = routerOn();
          if (!enabled) return Response.json({ enabled: false, killed: true });
          try {
            const config = loadRoutingConfig(configPath());
            return Response.json({
              enabled: true,
              killed: false,
              fallbackId: config.meta.fallbackId,
              notice: config.meta.notice,
              routes: Object.entries(config.routes).map(([id, r]) => ({
                id,
                label: r.label,
                skill: r.skill,
                axes: r.axes,
              })),
            });
          } catch (error) {
            return Response.json({ enabled: true, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
          }
        }),
      POST: ({ request }) =>
        guarded("POST /api/router", async () => {
          if (!routerOn()) return Response.json({ message: "Router tắt (SABLE_ROUTER=0)." }, { status: 409 });
          const read = await readObjectBody(request, MAX_BODY);
          if (!read.ok) return read.response;
          const hint = typeof read.body.hint === "string" ? read.body.hint : "";
          if (!hint.trim()) return Response.json({ message: "Thiếu hint." }, { status: 400 });
          const config = loadRoutingConfig(configPath());
          return Response.json({ enabled: true, hit: classify(hint, config) });
        }),
      ANY: methodNotAllowed("GET, POST"),
    },
  },
});
