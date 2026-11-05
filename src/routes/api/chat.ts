import { createFileRoute } from "@tanstack/react-router";
import { parseChatRequest, providerInfo, streamChat } from "@/server/chat.server";
import { methodNotAllowed, readJsonBody } from "@/server/http";

const MAX_BODY = 1_500_000;

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      GET: () => Response.json(providerInfo()),
      POST: async ({ request }) => {
        const read = await readJsonBody(request, MAX_BODY);
        if (!read.ok) return Response.json({ message: read.message }, { status: read.status });
        const parsed = parseChatRequest(read.value);
        if (!parsed.ok) return Response.json({ message: parsed.error }, { status: 400 });
        return streamChat(parsed.request, parsed.notices, request.signal);
      },
      ANY: methodNotAllowed("GET, POST"),
    },
  },
});
