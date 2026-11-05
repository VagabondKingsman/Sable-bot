import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CanvasStore, MAX_HTML, MAX_VERSIONS, validCanvasId } from "./store.ts";
import { CANVAS_CSP, IFRAME_SANDBOX, canvasHeaders, renderCanvasDocument, sanitizeCanvasHtml, withNavGuard } from "./render.ts";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sable-canvas-"));
}

test("canvas: create → versions are immutable and readable", () => {
  const dir = tmp();
  let t = 1000;
  const s = new CanvasStore(dir, { now: () => (t += 10) });
  const a = s.create({ title: "  Báo cáo\n Q3 ", html: "<h1>v1</h1>" });
  assert.ok(a.ok);
  if (!a.ok) return;
  assert.ok(validCanvasId(a.canvas.id));
  assert.equal(a.canvas.title, "Báo cáo Q3");
  const b = s.update(a.canvas.id, { html: "<h1>v2</h1>", note: "sửa", by: "agent" });
  assert.ok(b.ok);
  assert.equal(s.get(a.canvas.id)?.html, "<h1>v2</h1>");
  assert.equal(s.get(a.canvas.id)?.shownVersion, 2);
  assert.equal(s.get(a.canvas.id, 1)?.html, "<h1>v1</h1>");
  assert.equal(s.get(a.canvas.id, 9), null);
  const meta = s.get(a.canvas.id);
  assert.deepEqual(meta?.versions.map((v) => [v.version, v.by, v.note ?? null]), [[1, "owner", null], [2, "agent", "sửa"]]);
  assert.equal(s.list().length, 1);
  assert.equal(s.list()[0]?.version, 2);
  const st = fs.statSync(path.join(dir, "canvases", a.canvas.id, "v1.html"));
  assert.equal(st.mode & 0o777, 0o600);
  assert.ok(s.remove(a.canvas.id));
  assert.equal(s.list().length, 0);
});

test("canvas: limits, bad ids, version cap", () => {
  const s = new CanvasStore(tmp());
  assert.equal(s.create({ html: "" }).ok, false);
  assert.equal(s.create({ html: "x".repeat(MAX_HTML + 1) }).ok, false);
  assert.equal(s.get("../etc"), null);
  assert.equal(s.update("c_../../x", { html: "a" }).ok, false);
  assert.equal(s.remove("nope"), false);
  const c = s.create({ html: "v1" });
  assert.ok(c.ok);
  if (!c.ok) return;
  for (let i = 2; i <= MAX_VERSIONS + 5; i++) assert.ok(s.update(c.canvas.id, { html: `v${i}` }).ok);
  const doc = s.get(c.canvas.id);
  assert.equal(doc?.versions.length, MAX_VERSIONS);
  assert.equal(doc?.version, MAX_VERSIONS + 5);
  assert.equal(s.get(c.canvas.id, 1), null);
  assert.equal(s.get(c.canvas.id, 6)?.html, "v6");
});

test("canvas: CSP sandbox — scripts only, no same-origin, no network, no frames", () => {
  assert.equal(IFRAME_SANDBOX, "allow-scripts");
  assert.ok(CANVAS_CSP.startsWith("sandbox allow-scripts;"));
  assert.ok(!/allow-same-origin|allow-top-navigation|allow-forms|allow-popups/.test(CANVAS_CSP));
  for (const d of ["default-src 'none'", "connect-src 'none'", "frame-src 'none'", "form-action 'none'", "base-uri 'none'", "object-src 'none'", "frame-ancestors 'self'"]) assert.ok(CANVAS_CSP.includes(d), d);
  assert.ok(!/https?:/.test(CANVAS_CSP), "no remote origins allowed");
  const h = canvasHeaders();
  assert.equal(h["Content-Security-Policy"], CANVAS_CSP);
  assert.equal(h["X-Content-Type-Options"], "nosniff");
  assert.equal(h["Referrer-Policy"], "no-referrer");
});

test("canvas: sanitize strips meta refresh / base / frames; fragments get a skeleton", () => {
  const dirty = `<meta http-equiv="refresh" content="0;url=https://evil"><base href="https://evil/"><iframe src="https://evil"></iframe><object data=x></object><p>ok</p>`;
  const clean = sanitizeCanvasHtml(dirty);
  assert.ok(!/http-equiv|<base|<iframe|<object/i.test(clean));
  assert.ok(clean.includes("<p>ok</p>"));
  const doc = renderCanvasDocument("<p>hi</p>", "<T>");
  assert.ok(doc.startsWith("<!doctype html>"));
  assert.ok(doc.includes("<title>&lt;T&gt;</title>"));
  const full = "<!doctype html><html><body>x</body></html>";
  assert.equal(renderCanvasDocument(full, "t"), withNavGuard(full)); // W2c: guard script injected
});

test("canvas_write tool: write risk, approval, kill switch, registered under its own server-set flag", async () => {
  const dir = tmp();
  const prev = { data: process.env.SABLE_DATA_DIR, canvas: process.env.SABLE_CANVAS };
  process.env.SABLE_DATA_DIR = dir;
  try {
    const { canvasWrite } = await import("../tools/canvas.ts");
    const { FLAG_OF, builtinTools } = await import("../tools/registry.ts");
    assert.equal(canvasWrite.risk, "write");
    assert.equal(canvasWrite.needsApproval, true);
    assert.equal(FLAG_OF.canvas_write, "canvas");
    assert.ok(builtinTools().some((t) => t.name === "canvas_write"));
    const ctx = { workspaceDir: dir, signal: new AbortController().signal, mode: "chat" } as never;
    assert.match(String(await canvasWrite.check?.({ title: "t", html: "<p>x</p>", id: "bad" }, ctx)), /id/);
    assert.equal(await canvasWrite.check?.({ title: "t", html: "<p>x</p>" }, ctx), null);
    const card = canvasWrite.describe?.({ title: "t", html: "<p>x</p>" });
    assert.match(String(card?.summary), /sandbox/);
    const res = await canvasWrite.run({ title: "t", html: "<p>x</p>" }, ctx);
    assert.ok(res.ok);
    assert.match(res.output, /canvas id=c_[a-f0-9]+ version=1/);
    process.env.SABLE_CANVAS = "0";
    assert.match(String(await canvasWrite.check?.({ title: "t", html: "<p>x</p>" }, ctx)), /SABLE_CANVAS=0/);
    assert.equal((await canvasWrite.run({ title: "t", html: "<p>x</p>" }, ctx)).ok, false);
  } finally {
    if (prev.data === undefined) delete process.env.SABLE_DATA_DIR;
    else process.env.SABLE_DATA_DIR = prev.data;
    if (prev.canvas === undefined) delete process.env.SABLE_CANVAS;
    else process.env.SABLE_CANVAS = prev.canvas;
  }
});
