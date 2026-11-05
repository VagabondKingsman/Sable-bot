import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CANVAS_CSP, IFRAME_SANDBOX, NAV_GUARD_JS, renderCanvasDocument, sanitizeCanvasHtml, withNavGuard } from "./render.ts";
import { MAX_ACTIVE_SHARES, ShareStore, shareOn, validShareToken } from "./shares.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "sable-share-"));

test("share: token shown once, only its hash on disk (0600), resolves while active", () => {
  const dir = tmp();
  const s = new ShareStore(dir);
  const r = s.create({ canvasId: "c_0123456789abcdef", ttlHours: 2 });
  assert.ok(r.ok);
  assert.ok(validShareToken(r.token));
  const disk = fs.readFileSync(path.join(dir, "canvas-shares.json"), "utf8");
  assert.ok(!disk.includes(r.token));
  assert.equal(fs.statSync(path.join(dir, "canvas-shares.json")).mode & 0o777, 0o600);
  assert.equal(s.resolve(r.token, { count: true })?.id, r.share.id);
  assert.equal(s.list()[0].views, 1);
  assert.ok(!("hash" in s.list()[0]));
  assert.equal(s.resolve(`${r.token.slice(0, 42)}${r.token.endsWith("A") ? "B" : "A"}`), null);
  assert.equal(s.resolve("short"), null);
  assert.equal(s.resolve(undefined), null);
});

test("share: expires and revokes; uniform null afterwards", () => {
  let now = 1_000_000;
  const s = new ShareStore(tmp(), { now: () => now });
  const a = s.create({ canvasId: "c_0123456789abcdef", ttlHours: 1 });
  const b = s.create({ canvasId: "c_0123456789abcdef", ttlHours: 24, version: 3 });
  assert.ok(a.ok && b.ok);
  assert.equal(b.share.version, 3);
  now += 3_600_001;
  assert.equal(s.resolve(a.token), null);
  assert.equal(s.list().find((x) => x.id === a.share.id)?.state, "expired");
  assert.ok(s.resolve(b.token));
  assert.equal(s.revoke(b.share.id)?.state, "revoked");
  assert.equal(s.resolve(b.token), null);
  assert.equal(s.revoke("sh_nope"), null);
});

test("share: TTL bounds, active cap, revoke_all, kill switch", () => {
  const s = new ShareStore(tmp());
  assert.equal(s.create({ canvasId: "c_0123456789abcdef", ttlHours: 0.5 }).ok, false);
  assert.equal(s.create({ canvasId: "c_0123456789abcdef", ttlHours: 24 * 31 }).ok, false);
  for (let i = 0; i < MAX_ACTIVE_SHARES; i++) assert.ok(s.create({ canvasId: "c_0123456789abcdef" }).ok);
  assert.equal(s.create({ canvasId: "c_0123456789abcdef" }).ok, false);
  assert.equal(s.revokeAll("c_0123456789abcdef"), MAX_ACTIVE_SHARES);
  assert.ok(s.create({ canvasId: "c_0123456789abcdef" }).ok);
  assert.equal(shareOn({ SABLE_SHARE: "0" } as NodeJS.ProcessEnv), false);
  assert.equal(shareOn({} as NodeJS.ProcessEnv), true);
});

test("canvas: sandbox has no navigation/popup/form/same-origin; CSP sandboxes direct opens", () => {
  assert.equal(IFRAME_SANDBOX, "allow-scripts");
  assert.match(CANVAS_CSP, /sandbox allow-scripts;/);
  for (const bad of ["allow-top-navigation", "allow-popups", "allow-forms", "allow-same-origin"]) assert.ok(!CANVAS_CSP.includes(bad));
  assert.match(CANVAS_CSP, /form-action 'none'/);
  assert.match(CANVAS_CSP, /base-uri 'none'/);
});

test("canvas: nav guard is the first script; link targets / javascript: / meta refresh stripped", () => {
  const frag = renderCanvasDocument('<script>location.href="x"</script><a href="https://evil.example" target="_top">x</a><a href="javascript:alert(1)">y</a><meta http-equiv="refresh" content="0;url=https://evil.example"><button formaction="https://evil.example">b</button>', "T");
  assert.ok(frag.indexOf(NAV_GUARD_JS) > 0 && frag.indexOf(NAV_GUARD_JS) < frag.indexOf('location.href="x"'));
  assert.doesNotMatch(frag, /target=|javascript:|http-equiv="refresh"|formaction/i);
  const full = renderCanvasDocument("<!doctype html><html><head><script>1</script></head><body></body></html>", "T");
  assert.ok(full.indexOf(NAV_GUARD_JS) < full.indexOf("<script>1</script>"));
  assert.match(withNavGuard("<!DOCTYPE html><p>x</p>"), /^<!DOCTYPE html><script>/);
  assert.match(sanitizeCanvasHtml("<a href='#top'>ok</a>"), /href='#top'/);
});
