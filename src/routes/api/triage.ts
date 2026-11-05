import { createFileRoute } from "@tanstack/react-router";
import { guarded, methodNotAllowed, readObjectBody } from "@/server/http";
import { setItemState, triageFeed, triageOn } from "@/server/proactive.server";

/**
 * Triage feed (W2a). GET → items sorted needs_approval / needs_reply / fyi /
 * ignore with reason + decidedBy. POST { id, action: snooze|unsnooze|done|undone, ms? }
 * only changes local UI state — never sends or approves anything.
 */
export const Route = createFileRoute("/api/triage")({
  server: {
    handlers: {
      GET: ({ request }) =>
        guarded("GET /api/triage", async () => {
          const all = new URL(request.url).searchParams.get("all") === "1";
          return Response.json(await triageFeed({ includeDone: all }));
        }),
      POST: ({ request }) =>
        guarded("POST /api/triage", async () => {
          if (!triageOn()) return Response.json({ message: "Triage đang tắt (SABLE_TRIAGE=0)." }, { status: 503 });
          const read = await readObjectBody(request, 10_000);
          if (!read.ok) return read.response;
          const { id, action, ms } = read.body;
          if (typeof id !== "string" || !id || id.length > 120) return Response.json({ message: "Thiếu id." }, { status: 400 });
          if (action !== "snooze" && action !== "unsnooze" && action !== "done" && action !== "undone")
            return Response.json({ message: "Thao tác không hợp lệ." }, { status: 400 });
          const state = setItemState(id, action, typeof ms === "number" ? ms : undefined);
          return Response.json({ ok: true, state });
        }),
      ANY: methodNotAllowed("GET, POST"),
    },
  },
});
