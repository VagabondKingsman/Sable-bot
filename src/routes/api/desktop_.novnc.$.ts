import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createFileRoute } from "@tanstack/react-router";
import { guarded, methodNotAllowed } from "@/server/http";
import { desktopOn } from "@/server/desktop.server";

/** W3: noVNC static client (/usr/share/novnc) served behind the desk auth; frameable by Sable only. */
const ROOT = path.resolve(process.env.SABLE_NOVNC_DIR || "/usr/share/novnc");
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".oga": "audio/ogg", ".ogg": "audio/ogg", ".mp3": "audio/mpeg",
};

function novncFile(rel: string): string | null {
  if (!rel || rel.length > 300 || /(^|\/)\./.test(rel) || rel.includes("\0") || rel.includes("\\")) return null;
  const file = path.resolve(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep)) return null;
  if (!TYPES[path.extname(file).toLowerCase()]) return null;
  try {
    const real = fs.realpathSync(file);
    if (!real.startsWith("/usr/share/") && !real.startsWith(ROOT + path.sep)) return null;
    return fs.statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

/** CSP hashes for the inline module script(s) in noVNC's own html (no 'unsafe-inline'). */
function inlineHashes(html: string): string {
  const out: string[] = [];
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g))
    out.push(`'sha256-${crypto.createHash("sha256").update(m[1]!, "utf8").digest("base64")}'`);
  return out.join(" ");
}

export const Route = createFileRoute("/api/desktop_/novnc/$")({
  server: {
    handlers: {
      GET: ({ params }) =>
        guarded("GET /api/desktop/novnc", () => {
          if (!desktopOn()) return new Response("off", { status: 404 });
          const rel = String((params as { _splat?: string })._splat ?? "");
          const file = novncFile(rel);
          if (!file) return new Response("Not found", { status: 404 });
          const bytes = fs.readFileSync(file);
          const hashes = file.endsWith(".html") ? inlineHashes(bytes.toString("utf8")) : "";
          return new Response(bytes, {
            headers: {
              "Content-Type": TYPES[path.extname(file).toLowerCase()]!,
              "Cache-Control": "private, max-age=3600",
              "X-Content-Type-Options": "nosniff",
              "X-Frame-Options": "SAMEORIGIN",
              "Content-Security-Policy": `default-src 'self'; script-src 'self' ${hashes}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'`,
              "Referrer-Policy": "no-referrer",
            },
          });
        }),
      ANY: methodNotAllowed("GET"),
    },
  },
});
