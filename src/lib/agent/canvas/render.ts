/**
 * Rendering policy for Canvas Pages (D3). The page is agent/owner-authored HTML
 * that runs ONLY in the browser, inside:
 *  - <iframe sandbox="allow-scripts"> (no allow-same-origin → opaque origin: no
 *    cookies, no storage, no access to the parent desk or its APIs), and
 *  - a CSP response header carrying its own `sandbox` directive, so the same
 *    isolation holds when the share link is opened directly in a tab.
 * No network from the page (connect-src 'none'), no forms, no nested frames,
 * no <base>. Nothing is ever evaluated on the server.
 */

export const CANVAS_CSP = [
  "sandbox allow-scripts",
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "manifest-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join("; ");

/** The iframe attribute; deliberately WITHOUT allow-same-origin / top-navigation / forms / popups. */
export const IFRAME_SANDBOX = "allow-scripts";

export function canvasHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": CANVAS_CSP,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), usb=(), payment=(), clipboard-read=()",
    "Cache-Control": "no-store",
  };
}

/**
 * Defence in depth on top of the CSP: drop tags that could navigate, re-base or
 * embed (meta refresh / CSP override attempts, <base>, frames, objects). The CSP
 * header still governs; a <meta> CSP can only tighten, never loosen it.
 */
export function sanitizeCanvasHtml(html: string): string {
  return html
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?\s*(refresh|set-cookie|content-security-policy)[^>]*>/gi, "<!-- removed meta -->")
    .replace(/<base\b[^>]*>/gi, "<!-- removed base -->")
    .replace(/<(iframe|frame|frameset|object|embed|portal)\b[\s\S]*?(<\/\1\s*>|\/?>)/gi, "<!-- removed $1 -->");
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

/** Full document for the view route: fragments get a minimal skeleton. */
export function renderCanvasDocument(html: string, title: string): string {
  const clean = sanitizeCanvasHtml(html);
  if (/<html[\s>]/i.test(clean) || /<!doctype/i.test(clean)) return clean;
  return `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;margin:0;padding:16px;line-height:1.5;color:#111;background:#fff}</style></head>
<body>
${clean}
</body></html>`;
}
