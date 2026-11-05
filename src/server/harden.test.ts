import test from "node:test";
import assert from "node:assert/strict";
import { Harden, clientKey, hardenConfig, originAllowed } from "./harden.ts";

const cfg = (over = {}) => ({ ...hardenConfig({ SABLE_TRUSTED_ORIGINS: "https://undone.example.dev" }), ...over });
const req = (method: string, path: string, headers: Record<string, string> = {}, remote = "127.0.0.1") => ({ method, path, headers, remote });

test("CSRF: cross-site POST refused; same-origin, trusted, localhost, curl allowed; machine endpoints exempt", () => {
  const hd = new Harden(() => cfg());
  assert.equal(hd.check(req("POST", "/api/tools", { origin: "https://evil.example", host: "undone.example.dev" })).ok, false);
  assert.equal(hd.check(req("POST", "/api/tools", { origin: "null" })).ok, false);
  assert.equal(hd.check(req("POST", "/api/tools", { "sec-fetch-site": "cross-site" })).ok, false);
  assert.equal(hd.check(req("POST", "/api/tools", { origin: "https://undone.example.dev" })).ok, true);
  assert.equal(hd.check(req("POST", "/api/tools", { origin: "https://x.ngrok.dev", host: "x.ngrok.dev" })).ok, true);
  assert.equal(hd.check(req("POST", "/api/tools", { origin: "http://localhost:8080" })).ok, true);
  assert.equal(hd.check(req("POST", "/api/tools", {})).ok, true, "curl / no Origin");
  assert.equal(hd.check(req("GET", "/api/tools", { origin: "https://evil.example" })).ok, true, "reads are not CSRF-gated");
  assert.equal(hd.check(req("POST", "/api/channels/webhook", { origin: "https://evil.example" })).ok, true);
  assert.equal(hd.check(req("POST", "/api/routines/rtn_1/fire", { origin: "https://evil.example" })).ok, true);
  assert.equal(new Harden(() => cfg({ csrfOn: false })).check(req("POST", "/api/tools", { origin: "https://evil.example" })).ok, true);
  assert.equal(originAllowed(req("POST", "/", { origin: "https://evil.example", "x-forwarded-host": "evil.example", host: "undone.example.dev" }), cfg()), false, "X-Forwarded-Host is not trusted");
});

test("size cap: Content-Length over the cap → 413 before routes", () => {
  const hd = new Harden(() => cfg({ maxBody: 1000 }));
  const v = hd.check(req("POST", "/api/chat", { "content-length": "5000" }));
  assert.deepEqual(v.ok ? null : v.status, 413);
  assert.equal(hd.check(req("GET", "/assets/x.js", { "content-length": "5000" })).ok, true);
});

test("rate limits: per IP per class, loopback without XFF exempt, window resets", () => {
  let t = 0;
  const hd = new Harden(() => cfg({ limits: { read: 3, write: 2, share: 2 } }), () => t);
  const ext = { "x-forwarded-for": "203.0.113.9, 10.0.0.1" };
  for (let i = 0; i < 3; i++) assert.equal(hd.check(req("GET", "/api/jobs", ext)).ok, true);
  const v = hd.check(req("GET", "/api/jobs", ext));
  assert.equal(v.ok ? 0 : v.status, 429);
  assert.equal(hd.check(req("GET", "/api/jobs", { "x-forwarded-for": "198.51.100.2" })).ok, true, "other IP");
  assert.equal(hd.check(req("GET", "/s/abc", ext)).ok, true);
  assert.equal(hd.check(req("GET", "/s/abc", ext)).ok, true);
  assert.equal(hd.check(req("GET", "/s/abc", ext)).ok, false, "share class limited separately");
  for (let i = 0; i < 50; i++) assert.equal(hd.check(req("GET", "/api/jobs", {}, "127.0.0.1")).ok, true, "loopback exempt");
  t += 60_000;
  assert.equal(hd.check(req("GET", "/api/jobs", ext)).ok, true, "new window");
  assert.equal(clientKey(req("GET", "/", {}, "::ffff:127.0.0.1")), null);
  assert.equal(clientKey(req("GET", "/", {}, "192.0.2.5")), "192.0.2.5");
  assert.equal(new Harden(() => cfg({ rateOn: false, limits: { read: 1, write: 1, share: 1 } })).check(req("GET", "/api/x", ext)).ok, true);
});
