import { createFileRoute } from "@tanstack/react-router";
import { createImage, createVideo, deleteMedia, fileUrl, itemByRequestId, mediaOverview, pollVideo } from "@/server/media.server";
import { guarded, methodNotAllowed, readObjectBody } from "@/server/http";
import { mediaEnabled } from "@/lib/agent/media/providers";
import type { MediaItem } from "@/lib/agent/media/types";

function view(item: MediaItem) {
  const { requestId: _r, ...rest } = item;
  return { ...rest, url: item.file ? fileUrl(item.id) : (item.remoteUrl ?? null) };
}

/**
 * POST {kind:"image"|"video", prompt, ...}   generate (saved to the library; budget-gated; no approval)
 * POST {action:"refresh", id}                 poll a pending video
 * POST {action:"delete", id}                  remove item + file
 * GET  ?list=1                                providers (configured or not, with reason) + library
 * GET  ?id=<requestId>                        legacy chat video poll
 */
export const Route = createFileRoute("/api/media")({
  server: {
    handlers: {
      POST: ({ request }) =>
        guarded("POST /api/media", async () => {
          const read = await readObjectBody(request, 200_000);
          if (!read.ok) return read.response;
          const body = read.body;
          if (!mediaEnabled() && body.action !== "delete") return Response.json({ message: "Media đang tắt (SABLE_MEDIA=0).", code: "disabled" }, { status: 403 });
          if (body.action === "delete") {
            if (typeof body.id !== "string") return Response.json({ message: "Thiếu id." }, { status: 400 });
            return Response.json({ ok: deleteMedia(body.id) });
          }
          if (body.action === "refresh") {
            if (typeof body.id !== "string") return Response.json({ message: "Thiếu id." }, { status: 400 });
            const res = await pollVideo(body.id, request.signal);
            return res.ok ? Response.json({ item: view(res.item) }) : Response.json({ message: res.message, code: res.code }, { status: res.status });
          }
          if (body.prompt !== undefined && typeof body.prompt !== "string") return Response.json({ message: "Thiếu mô tả." }, { status: 400 });
          const prompt = typeof body.prompt === "string" ? body.prompt : "";
          if (body.kind === "image") {
            const res = await createImage(prompt, request.signal, {
              model: body.imageModel,
              aspect: body.imageAspect,
              resolution: body.imageResolution,
              provider: body.provider,
            });
            if (!res.ok) return Response.json({ message: res.message, code: res.code }, { status: res.status });
            return Response.json({ url: fileUrl(res.item.id), item: view(res.item) });
          }
          if (body.kind === "video") {
            const res = await createVideo(prompt, request.signal, { aspect: body.videoAspect, seconds: body.videoSeconds });
            if (!res.ok) return Response.json({ message: res.message, code: res.code }, { status: res.status });
            return Response.json({ requestId: res.item.requestId, item: view(res.item) });
          }
          return Response.json({ message: "Loại không hợp lệ." }, { status: 400 });
        }),
      GET: ({ request }) =>
        guarded("GET /api/media", async () => {
          const url = new URL(request.url);
          if (url.searchParams.get("list") === "1") {
            const o = mediaOverview();
            return Response.json({ providers: o.providers, items: o.items.map(view) }, { headers: { "Cache-Control": "no-store" } });
          }
          if (!mediaEnabled()) return Response.json({ message: "Media đang tắt (SABLE_MEDIA=0).", code: "disabled" }, { status: 403 });
          const requestId = url.searchParams.get("id") ?? "";
          const item = /^[\w-]{8,80}$/.test(requestId) ? itemByRequestId(requestId) : null;
          if (!item) return Response.json({ message: "Mã video không hợp lệ." }, { status: 404 });
          const res = await pollVideo(item.id, request.signal);
          if (!res.ok) return Response.json({ message: res.message }, { status: res.status });
          const v = view(res.item);
          if (res.item.status === "ready" && v.url) return Response.json({ status: "done", url: v.url, item: v });
          if (res.item.status === "failed") return Response.json({ status: "failed", message: res.item.error ?? "Video lỗi." });
          return Response.json({ status: "pending" });
        }),
      ANY: methodNotAllowed("GET, POST"),
    },
  },
});
