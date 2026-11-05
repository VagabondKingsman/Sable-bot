import { createFileRoute } from "@tanstack/react-router";
import { guarded, methodNotAllowed, readObjectBody } from "@/server/http";
import { dataDir } from "@/server/paths";
import { memoryKillSwitch, memoryStore } from "@/server/memory.server";
import { MAX_MEMORY_TEXT } from "@/lib/agent/memory/types";

const MAX_BODY = 1_000_000;
const MAX_IDS = 1_000;

function bad(message: string, status = 400) {
  return Response.json({ message }, { status });
}

function idsOf(value: unknown): string[] | "all" | null {
  if (value === "all") return "all";
  if (Array.isArray(value) && value.length > 0 && value.length <= MAX_IDS && value.every((id) => typeof id === "string" && id.length <= 80)) return value;
  return null;
}

function snapshot() {
  const store = memoryStore(dataDir());
  return { enabled: store.enabled(), killed: memoryKillSwitch(), stats: store.stats() };
}

/**
 * Learned memory (the user's own panel).
 * GET ?q=&export=1 → items (+ state). POST { action: add|update|delete|toggle|import, ... }.
 */
export const Route = createFileRoute("/api/memory")({
  server: {
    handlers: {
      GET: ({ request }) =>
        guarded("GET /api/memory", () => {
          const store = memoryStore(dataDir());
          const url = new URL(request.url);
          if (url.searchParams.get("export") === "1") {
            return new Response(JSON.stringify(store.exportFile(), null, 2), {
              headers: { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": 'attachment; filename="sable-memory.json"', "Cache-Control": "no-store" },
            });
          }
          const q = (url.searchParams.get("q") ?? "").slice(0, 200).trim();
          return Response.json({ ...snapshot(), items: q ? store.search(q, 200) : store.list() }, { headers: { "Cache-Control": "no-store" } });
        }),
      POST: ({ request }) =>
        guarded("POST /api/memory", async () => {
          const read = await readObjectBody(request, MAX_BODY);
          if (!read.ok) return read.response;
          const body = read.body;
          const store = memoryStore(dataDir());
          switch (body.action) {
            case "add": {
              if (typeof body.text !== "string" || !body.text.trim()) return bad("Thiếu nội dung.");
              if (body.text.length > MAX_MEMORY_TEXT * 2) return bad(`Tối đa ${MAX_MEMORY_TEXT} ký tự.`);
              if (!store.enabled()) return bad("Bộ nhớ đang tắt.", 409);
              const result = store.add({
                text: body.text,
                kind: body.kind === "journal" ? "journal" : "profile",
                source: "user",
                pinned: body.pinned === true,
                eventDate: typeof body.eventDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.eventDate) ? body.eventDate : undefined,
              });
              if (result.status === "skipped") return bad("Không lưu: trống hoặc trông giống bí mật (mật khẩu, khoá, số thẻ…).", 422);
              return Response.json({ ok: true, status: result.status, memory: result.memory, ...snapshot() });
            }
            case "update": {
              if (typeof body.id !== "string" || body.id.length > 80) return bad("Thiếu id.");
              const patch: Record<string, unknown> = {};
              if (body.text !== undefined) {
                if (typeof body.text !== "string" || !body.text.trim() || body.text.length > MAX_MEMORY_TEXT * 2) return bad("Nội dung không hợp lệ.");
                patch.text = body.text;
              }
              if (body.kind !== undefined) {
                if (body.kind !== "profile" && body.kind !== "journal") return bad("Loại không hợp lệ.");
                patch.kind = body.kind;
              }
              if (body.pinned !== undefined) {
                if (typeof body.pinned !== "boolean") return bad("pinned phải là true/false.");
                patch.pinned = body.pinned;
              }
              if (body.eventDate !== undefined) {
                if (body.eventDate !== null && (typeof body.eventDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.eventDate))) return bad("Ngày phải dạng YYYY-MM-DD.");
                patch.eventDate = body.eventDate;
              }
              if (!Object.keys(patch).length) return bad("Không có gì để sửa.");
              const result = store.update(body.id, patch);
              if (!result) return bad("Không tìm thấy mục này.", 404);
              if ("error" in result) return bad(result.error, 422);
              return Response.json({ ok: true, memory: result });
            }
            case "delete": {
              const ids = idsOf(body.ids);
              if (!ids) return bad(`Thiếu ids (tối đa ${MAX_IDS}, hoặc "all").`);
              return Response.json({ ok: true, removed: store.remove(ids), ...snapshot() });
            }
            case "toggle": {
              if (typeof body.enabled !== "boolean") return bad("enabled phải là true/false.");
              store.setEnabled(body.enabled);
              return Response.json({ ok: true, ...snapshot() });
            }
            case "import": {
              const mode = body.mode === "replace" ? "replace" : body.mode === undefined || body.mode === "merge" ? "merge" : null;
              if (!mode) return bad("mode phải là merge hoặc replace.");
              if (!store.enabled()) return bad("Bộ nhớ đang tắt.", 409);
              const result = store.importItems(body.data, mode);
              if ("error" in result) return bad(result.error as string);
              return Response.json({ ok: true, ...result, ...snapshot() });
            }
            default:
              return bad("Thao tác không hợp lệ.");
          }
        }),
      ANY: methodNotAllowed("GET, POST"),
    },
  },
});
