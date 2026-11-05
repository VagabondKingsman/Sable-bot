import { createFileRoute } from "@tanstack/react-router";
import { guarded, methodNotAllowed } from "@/server/http";
import { getShot } from "@/server/desktop.server";

/** W3: one stored desktop screenshot (owner-only, behind the desk auth). */
export const Route = createFileRoute("/api/desktop_/shot/$id")({
  server: {
    handlers: {
      GET: ({ params }) =>
        guarded("GET /api/desktop/shot", () => {
          const jpeg = getShot(String(params.id));
          if (!jpeg) return new Response("Not found", { status: 404 });
          return new Response(new Uint8Array(jpeg), {
            headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" },
          });
        }),
      ANY: methodNotAllowed("GET"),
    },
  },
});
