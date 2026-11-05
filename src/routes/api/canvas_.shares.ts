import { createFileRoute } from "@tanstack/react-router";
import { guarded, methodNotAllowed, readObjectBody } from "@/server/http";
import { canvasOn, canvasStore } from "@/lib/agent/tools/canvas";
import { validCanvasId } from "@/lib/agent/canvas/store";
import { shareOn } from "@/lib/agent/canvas/shares";
import { USER } from "@/lib/agent/audit/types";
import { audit } from "@/server/audit.server";
import { shareBase, shareStore } from "@/server/shares.server";

/**
 * W2c owner-only share-link management (behind the desk auth like every /api route).
 * GET  /api/canvas/shares[?canvas=<id>]                    list (never returns tokens)
 * POST {action:"create", canvasId, version?, ttlHours?}     → { share, url } — the token is shown ONCE
 * POST {action:"revoke", id} | {action:"revoke_all", canvasId?}
 * Kill switch SABLE_SHARE=0 (and SABLE_CANVAS=0): creation 403, every /s/ link 404.
 */
const NO_STORE = { "Cache-Control": "no-store" };
export const Route = createFileRoute("/api/canvas_/shares")({
  server: {
    handlers: {
      GET: ({ request }) =>
        guarded("GET /api/canvas/shares", () => {
          const id = new URL(request.url).searchParams.get("canvas") ?? undefined;
          if (id !== undefined && !validCanvasId(id)) return Response.json({ message: "Mã canvas không hợp lệ." }, { status: 400 });
          return Response.json({ enabled: shareOn() && canvasOn(), items: shareStore().list(id) }, { headers: NO_STORE });
        }),
      POST: ({ request }) =>
        guarded("POST /api/canvas/shares", async () => {
          const read = await readObjectBody(request, 4_000);
          if (!read.ok) return read.response;
          const b = read.body;
          const store = shareStore();
          if (b.action === "create") {
            if (!shareOn() || !canvasOn()) return Response.json({ message: "Chia sẻ đang tắt (SABLE_SHARE=0 / SABLE_CANVAS=0).", code: "disabled" }, { status: 403 });
            if (!validCanvasId(b.canvasId)) return Response.json({ message: "Mã canvas không hợp lệ." }, { status: 400 });
            const version = typeof b.version === "number" ? b.version : null;
            if (!canvasStore().get(b.canvasId, version)) return Response.json({ message: "Không tìm thấy canvas / phiên bản." }, { status: 404 });
            const res = store.create({ canvasId: b.canvasId, version, ttlHours: typeof b.ttlHours === "number" ? b.ttlHours : undefined });
            if (!res.ok) return Response.json({ message: res.error }, { status: 400 });
            audit({ type: "side_effect", initiator: USER, tool: "canvas.share", summary: `${b.canvasId}${version ? ` v${version}` : ""}: ${res.share.id} until ${new Date(res.share.expiresAt).toISOString()}`, ok: true });
            return Response.json({ share: res.share, url: `${shareBase(request)}/s/${res.token}` }, { status: 201, headers: NO_STORE });
          }
          if (b.action === "revoke") {
            if (typeof b.id !== "string") return Response.json({ message: "Thiếu id." }, { status: 400 });
            const s = store.revoke(b.id);
            if (!s) return Response.json({ message: "Không tìm thấy link." }, { status: 404 });
            audit({ type: "side_effect", initiator: USER, tool: "canvas.share_revoke", summary: `${s.canvasId}: ${s.id}`, ok: true });
            return Response.json({ share: s });
          }
          if (b.action === "revoke_all") {
            const canvasId = b.canvasId === undefined ? undefined : b.canvasId;
            if (canvasId !== undefined && !validCanvasId(canvasId)) return Response.json({ message: "Mã canvas không hợp lệ." }, { status: 400 });
            const n = store.revokeAll(canvasId);
            audit({ type: "side_effect", initiator: USER, tool: "canvas.share_revoke", summary: `${canvasId ?? "all"}: ${n} link(s)`, ok: true });
            return Response.json({ revoked: n });
          }
          return Response.json({ message: "action phải là create | revoke | revoke_all." }, { status: 400 });
        }),
      ANY: methodNotAllowed("GET, POST"),
    },
  },
});
