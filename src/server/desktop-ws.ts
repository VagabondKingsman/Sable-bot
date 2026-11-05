/**
 * W3: raw WebSocket upgrade bridge for noVNC → websockify (127.0.0.1 only). Used by the Vite
 * server plugin (no app imports here). The desktop server registers the live target on
 * globalThis; no session → the upgrade is refused. Origin is checked like CSRF (a foreign page
 * must not open the owner's desktop stream with cached basic-auth credentials).
 */
import net from "node:net";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

export const VNC_WS_PATH = "/api/desktop/vnc";
export type VncTarget = { port: number; running: () => boolean; viewer: (delta: 1 | -1) => void };
const KEY = Symbol.for("sable.desktop.vnc");

export function setVncTarget(t: VncTarget | null) {
  (globalThis as Record<symbol, unknown>)[KEY] = t;
}
export function vncTarget(): VncTarget | null {
  return ((globalThis as Record<symbol, unknown>)[KEY] as VncTarget | null) ?? null;
}

const refuse = (socket: Duplex, status: string) => {
  try {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch {
    socket.destroy();
  }
};

/** Returns true when the request was ours (handled or refused). */
export function handleVncUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, originOk: (req: IncomingMessage) => boolean): boolean {
  const url = (req.url ?? "").split("?")[0];
  if (url !== VNC_WS_PATH) return false;
  const target = vncTarget();
  if (!originOk(req)) return refuse(socket, "403 Forbidden"), true;
  if (!target || !target.running()) return refuse(socket, "404 Not Found"), true;
  const up = net.connect({ host: "127.0.0.1", port: target.port });
  let counted = false;
  const done = () => {
    if (counted) target.viewer(-1);
    counted = false;
    up.destroy();
    socket.destroy();
  };
  up.on("connect", () => {
    target.viewer(1);
    counted = true;
    const lines = [`GET / HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i];
      // Credentials and proxy headers stay here; websockify only needs the WS handshake.
      if (/^(authorization|cookie|x-forwarded-|forwarded$)/i.test(name)) continue;
      lines.push(`${name}: ${req.rawHeaders[i + 1]}`);
    }
    up.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head?.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on("error", done);
  up.on("close", done);
  socket.on("error", done);
  socket.on("close", done);
  return true;
}
