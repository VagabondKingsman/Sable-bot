import { createFileRoute } from "@tanstack/react-router";
import { methodNotAllowed } from "@/server/http";
import { chatQueueOn, turnManager } from "@/server/turns.server";

/**
 * W7: GET /api/turns/stream?turn=<id>&after=<seq> — replay a turn's events after `seq`, then follow
 * live (SSE, each frame carries `id: <seq>`). Disconnecting only unsubscribes: the turn keeps running
 * server-side and can be resumed with the last seen seq.
 */
export const Route = createFileRoute("/api/turns_/stream")({
  server: {
    handlers: {
      GET: ({ request }) => {
        if (!chatQueueOn()) return Response.json({ message: "SABLE_CHAT_QUEUE=0" }, { status: 409 });
        const url = new URL(request.url);
        const turn = url.searchParams.get("turn") ?? "";
        const after = Math.max(0, Number(url.searchParams.get("after")) || 0);
        if (!/^[A-Za-z0-9_-]{1,120}$/.test(turn)) return Response.json({ message: "turn?" }, { status: 400 });
        const manager = turnManager();
        if (!manager.session(turn)) return Response.json({ message: "Không còn lượt này." }, { status: 404 });
        const encoder = new TextEncoder();
        let off: (() => void) | null = null;
        let closed = false;
        let ping: ReturnType<typeof setInterval> | null = null;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const close = () => {
              if (closed) return;
              closed = true;
              off?.();
              if (ping) clearInterval(ping);
              try {
                controller.close();
              } catch {
                /* already closed */
              }
            };
            const write = (chunk: string) => {
              if (closed) return;
              try {
                controller.enqueue(encoder.encode(chunk));
              } catch {
                close();
              }
            };
            off = manager.subscribe(turn, after, (e) => {
              if (e.event === "end") {
                write(`event: end\ndata: ${JSON.stringify(e.data)}\n\n`);
                queueMicrotask(close);
                return;
              }
              write(`id: ${e.seq}\nevent: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
            });
            ping = setInterval(() => write(`: ping\n\n`), 15_000);
            request.signal.addEventListener("abort", close, { once: true });
          },
          cancel() {
            closed = true;
            off?.();
            if (ping) clearInterval(ping);
          },
        });
        return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" } });
      },
      ANY: methodNotAllowed("GET"),
    },
  },
});
