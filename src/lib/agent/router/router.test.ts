import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { classify, loadRoutingConfig, routerOn } from "./match.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../../../");
const CONFIG = path.join(ROOT, "skills/routing.json");

test("routerOn kill switch", () => {
  assert.equal(routerOn({}), true);
  assert.equal(routerOn({ SABLE_ROUTER: "0" }), false);
});

test("classify: research / code-review / doc-audit / fallback", () => {
  const cfg = loadRoutingConfig(CONFIG);
  const r1 = classify("Please research and summarize this article about climate", cfg);
  assert.equal(r1.routeId, "R1");
  assert.equal(r1.skill, "research-summary");
  assert.equal(r1.axes.intent, "research");
  const r2 = classify("code review my own repo diff", cfg);
  assert.equal(r2.routeId, "R2");
  assert.equal(r2.skill, "code-review");
  const r3 = classify("doc audit of my markdown notes", cfg);
  assert.equal(r3.routeId, "R3");
  const r4 = classify("implement a helper function in my workspace", cfg);
  assert.equal(r4.routeId, "R4");
  const g0 = classify("xin chào", cfg);
  assert.equal(g0.routeId, "G0");
});

test("classify: no RE/pentest routes exist in Sable pack", () => {
  const cfg = loadRoutingConfig(CONFIG);
  for (const id of Object.keys(cfg.routes)) {
    assert.ok(!/apk|pentest|pwn|frida|jadx|exploit|ctf/i.test(id + cfg.routes[id].skill + cfg.routes[id].label));
  }
});
