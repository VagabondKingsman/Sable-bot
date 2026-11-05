import { createFileRoute } from "@tanstack/react-router";
import { guarded, methodNotAllowed, readObjectBody } from "@/server/http";
import { deskChanges, deskExport, deskImport, deskSync, deskSyncEnabled } from "@/server/desk.server";
import type { DeskPush } from "@/lib/agent/desk/sync";

const MAX_BODY = 8_000_000;
const NO_STORE = { "Cache-Control": "no-store" };
const off = () => Response.json({ enabled: false }, { status: 409, headers: NO_STORE });
const sinceOf = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

/**
 * Chats + presets kept on the server so every tab/device sees the same desk.
 * GET ?since=rev → changes; GET ?export=1 → download. POST {action:"sync", since, push} | {action:"import", file}.
 */
export const Route = createFileRoute("/api/desk")({
  server: {
    handlers: {
      GET: ({ request }) =>
        guarded("GET /api/desk", () => {
          if (!deskSyncEnabled()) return off();
          const url = new URL(request.url);
          if (url.searchParams.get("export") === "1")
            return new Response(JSON.stringify(deskExport(), null, 2), {
              headers: { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": 'attachment; filename="sable-chats.json"', ...NO_STORE },
            });
          return Response.json({ enabled: true, ...deskChanges(sinceOf(Number(url.searchParams.get("since") ?? 0))) }, { headers: NO_STORE });
        }),
      POST: ({ request }) =>
        guarded("POST /api/desk", async () => {
          if (!deskSyncEnabled()) return off();
          const read = await readObjectBody(request, MAX_BODY);
          if (!read.ok) return read.response;
          const body = read.body;
          if (body.action === "sync") {
            const push = (body.push && typeof body.push === "object" ? body.push : {}) as DeskPush;
            if ((push.threads && !Array.isArray(push.threads)) || (push.deleted && !Array.isArray(push.deleted)))
              return Response.json({ message: "Dữ liệu đồng bộ không hợp lệ." }, { status: 400 });
            return Response.json({ enabled: true, ...deskSync(sinceOf(body.since), push) }, { headers: NO_STORE });
          }
          if (body.action === "import") {
            const result = deskImport(body.file);
            if (!result) return Response.json({ message: "Không phải tệp xuất của Sable." }, { status: 422 });
            return Response.json({ ok: true, ...result }, { headers: NO_STORE });
          }
          return Response.json({ message: "Hành động không hợp lệ." }, { status: 400 });
        }),
      ANY: methodNotAllowed("GET, POST"),
    },
  },
});
