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
 * W2c navigation guard, injected as the first script of every canvas document.
 * The sandbox (no allow-top-navigation / allow-popups / allow-forms) already
 * stops top/parent navigation, popups and form posts. Browsers have no CSP
 * directive for a frame navigating *itself*, so: link clicks (except #anchors)
 * and form submits are cancelled here, and the embedding desk / share wrapper
 * reloads the original page if the frame navigates anyway (see GUARD_PARENT_JS).
 */
export const NAV_GUARD_JS =
  "(function(){var s=function(e){var t=e.target,a=t&&t.closest?t.closest('a[href],area[href]'):null;if(!a)return;var h=a.getAttribute('href')||'';if(h.charAt(0)==='#'&&h.indexOf(':')<0)return;e.preventDefault();e.stopImmediatePropagation();};" +
  "document.addEventListener('click',s,true);document.addEventListener('auxclick',s,true);" +
  "document.addEventListener('submit',function(e){e.preventDefault();e.stopImmediatePropagation();},true);" +
  "try{window.open=function(){return null;};}catch(_){}})();";

/**
 * Parent-side guard (used by the share wrapper; the desk does the same in React):
 * the first `load` is the canvas itself; any later load means the frame navigated,
 * so the original document is restored. After 3 attempts the frame is removed.
 */
export const GUARD_PARENT_JS =
  "(function(){var f=document.getElementById('cv');if(!f)return;var src=f.getAttribute('src'),n=0,b=0;f.addEventListener('load',function(){n++;if(n===1)return;b++;var m=document.getElementById('nav');" +
  "if(b>3){f.remove();if(m)m.textContent='Đã chặn: trang liên tục tự điều hướng.';return;}if(m)m.textContent='Đã chặn một lần trang tự điều hướng.';n=0;f.setAttribute('src',src);});})();";

/**
 * Defence in depth on top of the CSP: drop tags that could navigate, re-base or
 * embed (meta refresh / CSP override attempts, <base>, frames, objects). The CSP
 * header still governs; a <meta> CSP can only tighten, never loosen it.
 */
export function sanitizeCanvasHtml(html: string): string {
  return html
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?\s*(refresh|set-cookie|content-security-policy)[^>]*>/gi, "<!-- removed meta -->")
    .replace(/<base\b[^>]*>/gi, "<!-- removed base -->")
    .replace(/<(iframe|frame|frameset|object|embed|portal)\b[\s\S]*?(<\/\1\s*>|\/?>)/gi, "<!-- removed $1 -->")
    // W2c: no target=_top/_parent/_blank, no javascript:/data: link targets, no form/button formaction.
    .replace(/\s(target|formaction|formtarget|ping)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(\shref\s*=\s*["']?)\s*(javascript|data|vbscript):/gi, "$1#blocked-");
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

/** Full document for the view route: fragments get a minimal skeleton. */
const GUARD_TAG = `<script>${NAV_GUARD_JS}</script>`;

/** Put the guard before any page script: right after <head>, else after <html>, else first. */
export function withNavGuard(doc: string): string {
  if (/<head\b[^>]*>/i.test(doc)) return doc.replace(/<head\b[^>]*>/i, (m) => `${m}${GUARD_TAG}`);
  if (/<html\b[^>]*>/i.test(doc)) return doc.replace(/<html\b[^>]*>/i, (m) => `${m}<head>${GUARD_TAG}</head>`);
  if (/^\s*<!doctype[^>]*>/i.test(doc)) return doc.replace(/^\s*<!doctype[^>]*>/i, (m) => `${m}${GUARD_TAG}`);
  return `${GUARD_TAG}${doc}`;
}

export function renderCanvasDocument(html: string, title: string): string {
  const clean = sanitizeCanvasHtml(html);
  if (/<html[\s>]/i.test(clean) || /<!doctype/i.test(clean)) return withNavGuard(clean);
  return `<!doctype html>
<html lang="vi"><head>${GUARD_TAG}<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;margin:0;padding:16px;line-height:1.5;color:#111;background:#fff}</style></head>
<body>
${clean}
</body></html>`;
}
