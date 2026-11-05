import { createFileRoute } from "@tanstack/react-router";
import { methodNotAllowed, readJsonBody } from "@/server/http";
import { parseChatRequest } from "@/server/chat.server";
import { cancelQueued, chatQueueOn, stopTurn, submitTurn, threadView } from "@/server/turns.server";

/**
 * W7 desk turn manager (owner-only, behind the desk auth; same-origin writes via the CSRF gate).
 * GET  /api/turns?thread=<id>   → running turn, queue, pending steer messages, threaded replies
 * POST {action:"submit", threadId, messageId, mode:auto|steer|queue|interrupt|fork, request, quote?, replyTo?}
 * POST {action:"stop", turnId} | {action:"cancel", threadId, id}
 * SABLE_CHAT_QUEUE=0 → 409 here; the desk uses the old /api/chat stream.
 */
const ID = /^[A-Za-z0-9_-]{1,120}$/;
const MODES = new Set(["auto", "steer", "queue", "interrupt", "fork"]);
const NO_STORE = { "Cache-Control": "no-store" };

export const Route = createFileRoute("/api/turns")({
  server: {
    handlers: {
      GET: ({ request }) => {
        const thread = new URL(request.url).searchParams.get("thread") ?? "";
        if (!chatQueueOn()) return Response.json({ enabled: false }, { headers: NO_STORE });
        if (!ID.test(thread)) return Response.json({ message: "Thiếu thread." }, { status: 400 });
        return Response.json(threadView(thread), { headers: NO_STORE });
      },
      POST: async ({ request }) => {
        if (!chatQueueOn()) return Response.json({ enabled: false, message: "Hàng đợi chat đang tắt (SABLE_CHAT_QUEUE=0)." }, { status: 409 });
        const read = await readJsonBody(request, 1_500_000);
        if (!read.ok) return Response.json({ message: read.message }, { status: read.status });
        const body = (read.value ?? {}) as Record<string, unknown>;
        if (body.action === "stop") {
          if (typeof body.turnId !== "string" || !ID.test(body.turnId)) return Response.json({ message: "turnId?" }, { status: 400 });
          return Response.json({ ok: stopTurn(body.turnId) });
        }
        if (body.action === "cancel") {
          if (typeof body.threadId !== "string" || !ID.test(body.threadId) || typeof body.id !== "string" || !ID.test(body.id)) return Response.json({ message: "id?" }, { status: 400 });
          return Response.json({ ok: cancelQueued(body.threadId, body.id) });
        }
        if (body.action !== "submit") return Response.json({ message: "action?" }, { status: 400 });
        const threadId = typeof body.threadId === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(body.threadId) ? body.threadId : null;
        const messageId = typeof body.messageId === "string" && ID.test(body.messageId) ? body.messageId : null;
        const mode = typeof body.mode === "string" && MODES.has(body.mode) ? (body.mode as "auto") : "auto";
        if (!threadId || !messageId) return Response.json({ message: "Thiếu threadId/messageId." }, { status: 400 });
        const parsed = parseChatRequest(body.request);
        if (!parsed.ok) return Response.json({ message: parsed.error }, { status: 400 });
        const q = body.quote && typeof body.quote === "object" ? (body.quote as { role?: unknown; excerpt?: unknown }) : null;
        const quote = q && typeof q.excerpt === "string" ? { role: q.role === "assistant" ? "assistant" : "user", excerpt: q.excerpt.slice(0, 4_000) } : null;
        const replyTo = typeof body.replyTo === "string" && ID.test(body.replyTo) ? body.replyTo : undefined;
        const out = submitTurn({ threadId, messageId, mode, request: { ...parsed.request, threadId }, quote, replyTo });
        if (!out.ok) return Response.json({ message: out.message }, { status: out.status });
        return Response.json({ ...out, notices: parsed.notices });
      },
      ANY: methodNotAllowed("GET, POST"),
    },
  },
});
