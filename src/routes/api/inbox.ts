import { createFileRoute } from "@tanstack/react-router";
import { jobService } from "@/server/jobs.server";
import { guarded, methodNotAllowed, readObjectBody } from "@/server/http";
import { markRead, removeItems, unreadCount } from "@/lib/agent/jobs/inbox";

const MAX_BODY = 100_000;
const MAX_IDS = 500;

function idsOf(value: unknown): string[] | "all" | null {
  if (value === "all") return "all";
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_IDS &&
    value.every((item) => typeof item === "string" && item.length <= 80)
  )
    return value;
  return null;
}

/** In-app inbox. GET → items + unread. POST { action: "read" | "delete", ids: string[] | "all" }. */
export const Route = createFileRoute("/api/inbox")({
  server: {
    handlers: {
      GET: () =>
        guarded("GET /api/inbox", () => {
          const { db } = jobService();
          return Response.json({
            unread: unreadCount(db),
            total: db.inbox().length,
            items: db.inbox().slice(0, 100),
          });
        }),
      POST: ({ request }) =>
        guarded("POST /api/inbox", async () => {
          const read = await readObjectBody(request, MAX_BODY);
          if (!read.ok) return read.response;
          const body = read.body;
          if (body.action !== "read" && body.action !== "delete")
            return Response.json({ message: "Thao tác không hợp lệ." }, { status: 400 });
          const ids = idsOf(body.ids);
          if (!ids)
            return Response.json(
              { message: `Thiếu ids (danh sách tối đa ${MAX_IDS} id, hoặc "all").` },
              { status: 400 },
            );
          const { db } = jobService();
          if (body.action === "read") markRead(db, ids);
          else removeItems(db, ids);
          return Response.json({ ok: true, unread: unreadCount(db) });
        }),
      ANY: methodNotAllowed("GET, POST"),
    },
  },
});
