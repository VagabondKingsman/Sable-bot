import fs from "node:fs";
import { createFileRoute } from "@tanstack/react-router";
import { guarded, methodNotAllowed } from "@/server/http";
import { mediaFile } from "@/server/media.server";

/** GET /api/media/file/<id> — library bytes (behind the same ngrok basic auth as everything else). */
export const Route = createFileRoute("/api/media_/file/$id")({
  server: {
    handlers: {
      GET: ({ params }) =>
        guarded("GET /api/media/file/$id", () => {
          const found = mediaFile(String(params.id ?? ""));
          if (!found || !found.item.mime) return Response.json({ message: "Không thấy tệp." }, { status: 404 });
          const bytes = fs.readFileSync(found.file);
          return new Response(bytes, {
            headers: {
              "Content-Type": found.item.mime,
              "Content-Length": String(bytes.byteLength),
              "Cache-Control": "private, max-age=86400",
              "X-Content-Type-Options": "nosniff",
              "Content-Security-Policy": "default-src 'none'; sandbox",
            },
          });
        }),
      ANY: methodNotAllowed("GET"),
    },
  },
});
