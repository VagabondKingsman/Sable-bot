import { createFileRoute } from "@tanstack/react-router";
import { guarded, methodNotAllowed, readObjectBody } from "@/server/http";
import { vaultStore } from "@/server/vault.server";

const MAX_BODY = 20_000;

/**
 * Secrets vault: list names only; put/get/delete by name.
 * GET never returns values. GET ?name=X returns { present: boolean } only unless action=reveal is explicitly forbidden — we never reveal via HTTP list; get for inject is server-internal.
 * Owner can POST action=put|delete|get. get returns value once for owner UI copy — still no logging.
 */
export const Route = createFileRoute("/api/vault")({
  server: {
    handlers: {
      GET: () =>
        guarded("GET /api/vault", () => {
          const store = vaultStore();
          return Response.json(
            { ...store.meta(), migrateHint: "Optional: copy keys from .env.local into vault via POST put; keep .env.local as bootstrap for SABLE_VAULT_KEY only." },
            { headers: { "Cache-Control": "no-store" } },
          );
        }),
      POST: ({ request }) =>
        guarded("POST /api/vault", async () => {
          const read = await readObjectBody(request, MAX_BODY);
          if (!read.ok) return read.response;
          const body = read.body;
          const store = vaultStore();
          const action = body.action;
          // W2b: OAuth tokens are server-internal — never revealed, written or deleted over HTTP (use Disconnect).
          if (typeof body.name === "string" && body.name.startsWith("OAUTH_TOKEN_") && action !== "has")
            return Response.json({ message: "OAuth token chỉ dùng nội bộ máy chủ (Disconnect trong Cài đặt để xoá)." }, { status: 403 });
          if (action === "put") {
            if (typeof body.name !== "string" || typeof body.value !== "string")
              return Response.json({ message: "Thiếu name/value." }, { status: 400 });
            const result = store.put(body.name, body.value);
            if (!result.ok) return Response.json({ message: result.error }, { status: 400 });
            return Response.json({ ok: true, names: store.list() });
          }
          if (action === "delete") {
            if (typeof body.name !== "string") return Response.json({ message: "Thiếu name." }, { status: 400 });
            return Response.json({ ok: store.remove(body.name), names: store.list() });
          }
          if (action === "get") {
            // Owner-only desk already behind auth gate; still never list values.
            if (typeof body.name !== "string") return Response.json({ message: "Thiếu name." }, { status: 400 });
            const value = store.get(body.name);
            if (value === null) return Response.json({ message: "Không có hoặc vault tắt." }, { status: 404 });
            return Response.json({ ok: true, name: body.name, value });
          }
          if (action === "has") {
            if (typeof body.name !== "string") return Response.json({ message: "Thiếu name." }, { status: 400 });
            return Response.json({ ok: true, present: store.list().includes(body.name) });
          }
          return Response.json({ message: "action không hợp lệ." }, { status: 400 });
        }),
      ANY: methodNotAllowed("GET, POST"),
    },
  },
});
