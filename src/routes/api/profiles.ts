import { createFileRoute } from "@tanstack/react-router";
import { guarded, methodNotAllowed, readJsonBody } from "@/server/http";
import { activateProfile, profilesStatus, removeProfile, saveProfile } from "@/server/profiles.server";

export const Route = createFileRoute("/api/profiles")({
  server: {
    handlers: {
      GET: () => guarded("GET /api/profiles", () => Response.json(profilesStatus(), { headers: { "cache-control": "no-store" } })),
      POST: ({ request }) =>
        guarded("POST /api/profiles", async () => {
          const read = await readJsonBody(request, 100_000);
          if (!read.ok) return Response.json({ message: read.message }, { status: read.status });
          if (!read.value || typeof read.value !== "object" || Array.isArray(read.value))
            return Response.json({ message: "Không đọc được yêu cầu." }, { status: 400 });
          const body = read.value as { action?: string; id?: string; profile?: unknown };
          if (body.action === "activate" && typeof body.id === "string") {
            const result = activateProfile(body.id);
            return result.ok
              ? Response.json(result)
              : Response.json({ message: result.message }, { status: 400 });
          }
          if (body.action === "delete" && typeof body.id === "string") {
            const result = removeProfile(body.id);
            return result.ok ? Response.json(result) : Response.json({ message: result.message }, { status: 400 });
          }
          if (body.action === "save") {
            const result = saveProfile(body.profile);
            return result.ok ? Response.json(result) : Response.json({ message: result.message }, { status: 400 });
          }
          return Response.json({ message: "action không hợp lệ (activate|save|delete)." }, { status: 400 });
        }),
      ANY: methodNotAllowed("GET, POST"),
    },
  },
});
