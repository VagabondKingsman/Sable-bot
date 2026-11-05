import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertReadyForAct } from "./guard.ts";
import { ScopeStore, scopeKillDenyAll } from "./store.ts";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sable-scope-"));
}

test("scope kill switch fail-closed", () => {
  assert.equal(scopeKillDenyAll({}), false);
  assert.equal(scopeKillDenyAll({ SABLE_SCOPE: "0" }), true);
  const store = new ScopeStore(tmp());
  const denied = assertReadyForAct(store, {
    requiresScope: true,
    scopeId: "x",
    mode: "interactive",
    env: { SABLE_SCOPE: "0" },
  });
  assert.equal(denied.ok, false);
});

test("deny without scope; approve path; expire; background still needs approve", () => {
  const store = new ScopeStore(tmp());
  const now = 1_700_000_000_000;
  assert.equal(
    assertReadyForAct(store, { requiresScope: true, mode: "interactive", scopeId: null, now }).ok,
    false,
  );
  const rec = store.create({
    target: "file:///workspace/sable-workspace/notes.md",
    purpose: "doc audit of own notes",
    owner: "He",
    ttlMs: 60_000,
    now,
  });
  assert.equal(rec.status, "pending");
  assert.equal(
    assertReadyForAct(store, { requiresScope: true, scopeId: rec.id, mode: "background", now }).ok,
    false,
  );
  store.decide(rec.id, "approved", "appr_1", now);
  const ok = assertReadyForAct(store, { requiresScope: true, scopeId: rec.id, mode: "background", now: now + 1_000 });
  assert.equal(ok.ok, true);
  const expired = assertReadyForAct(store, {
    requiresScope: true,
    scopeId: rec.id,
    mode: "interactive",
    now: now + 120_000,
  });
  assert.equal(expired.ok, false);
  assert.match(expired.reason, /expir/i);
  store.decide(store.create({ target: "t", purpose: "p", owner: "He", now }).id, "denied", undefined, now);
  const deniedRec = store.list().find((s) => s.status === "denied")!;
  assert.equal(
    assertReadyForAct(store, { requiresScope: true, scopeId: deniedRec.id, mode: "interactive", now }).ok,
    false,
  );
  // Non-ACT tools skip gate
  assert.equal(assertReadyForAct(store, { requiresScope: false, mode: "background", now }).ok, true);
});
