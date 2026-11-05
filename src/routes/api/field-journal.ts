import { createFileRoute } from "@tanstack/react-router";
import { guarded, methodNotAllowed, readObjectBody } from "@/server/http";
import { recallLessons, writeLesson } from "@/lib/agent/field-journal/journal";
import { memoryKillSwitch, memoryStore } from "@/server/memory.server";
import { dataDir } from "@/server/paths";

const MAX_BODY = 20_000;

export const Route = createFileRoute("/api/field-journal")({
  server: {
    handlers: {
      GET: ({ request }) =>
        guarded("GET /api/field-journal", () => {
          const store = memoryStore(dataDir());
          const q = new URL(request.url).searchParams.get("q") ?? "";
          return Response.json({
            killed: memoryKillSwitch(),
            items: recallLessons(store, q || "field-journal", 20),
          });
        }),
      POST: ({ request }) =>
        guarded("POST /api/field-journal", async () => {
          const read = await readObjectBody(request, MAX_BODY);
          if (!read.ok) return read.response;
          const body = read.body;
          if (body.action === "write") {
            if (typeof body.scenario !== "string" || typeof body.lesson !== "string")
              return Response.json({ message: "Thiếu scenario/lesson." }, { status: 400 });
            const store = memoryStore(dataDir());
            const result = writeLesson(store, {
              scenario: body.scenario,
              lesson: body.lesson,
              trap: typeof body.trap === "string" ? body.trap : undefined,
              workaround: typeof body.workaround === "string" ? body.workaround : undefined,
              routeId: typeof body.routeId === "string" ? body.routeId : undefined,
              skill: typeof body.skill === "string" ? body.skill : undefined,
              eventDate: typeof body.eventDate === "string" ? body.eventDate : undefined,
            });
            if (!result.ok) return Response.json({ message: result.error }, { status: 400 });
            return Response.json({ ok: true, id: result.id, text: result.text, status: result.status });
          }
          if (body.action === "recall") {
            const store = memoryStore(dataDir());
            const hint = typeof body.hint === "string" ? body.hint : "";
            return Response.json({ items: recallLessons(store, hint, 10) });
          }
          return Response.json({ message: "action không hợp lệ." }, { status: 400 });
        }),
      ANY: methodNotAllowed("GET, POST"),
    },
  },
});
