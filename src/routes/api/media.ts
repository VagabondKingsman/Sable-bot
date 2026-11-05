import { createFileRoute } from "@tanstack/react-router";
import { createImage, readVideo, startVideo } from "@/server/media.server";
import { methodNotAllowed, readJsonBody } from "@/server/http";

export const Route = createFileRoute("/api/media")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const read = await readJsonBody(request, 200_000);
        if (!read.ok) return Response.json({ message: read.message }, { status: read.status });
        if (!read.value || typeof read.value !== "object" || Array.isArray(read.value))
          return Response.json({ message: "Không đọc được yêu cầu." }, { status: 400 });
        const body = read.value as {
          kind?: string;
          prompt?: string;
          imageModel?: unknown;
          imageAspect?: unknown;
          imageResolution?: unknown;
          videoAspect?: unknown;
          videoSeconds?: unknown;
        };
        if (body.prompt !== undefined && typeof body.prompt !== "string")
          return Response.json({ message: "Thiếu mô tả." }, { status: 400 });
        if (body.kind === "image") {
          const result = await createImage(body.prompt ?? "", request.signal, {
            model: body.imageModel,
            aspect: body.imageAspect,
            resolution: body.imageResolution,
          });
          return result.ok ? Response.json({ url: result.url }) : Response.json({ message: result.message }, { status: 502 });
        }
        if (body.kind === "video") {
          const result = await startVideo(body.prompt ?? "", request.signal, {
            aspect: body.videoAspect,
            seconds: body.videoSeconds,
          });
          return result.ok
            ? Response.json({ requestId: result.requestId })
            : Response.json({ message: result.message }, { status: 502 });
        }
        return Response.json({ message: "Loại không hợp lệ." }, { status: 400 });
      },
      GET: async ({ request }) => {
        const id = new URL(request.url).searchParams.get("id") ?? "";
        const result = await readVideo(id, request.signal);
        if (!result.ok) return Response.json({ message: result.message }, { status: 502 });
        if (result.status === "done") return Response.json({ status: "done", url: result.url });
        if (result.status === "failed") return Response.json({ status: "failed", message: result.message });
        return Response.json({ status: "pending" });
      },
      ANY: methodNotAllowed("GET, POST"),
    },
  },
});
