import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  catchUpOn,
  healthSnapshot,
  readHeartbeat,
  tickHeartbeat,
  DEFAULT_SUSPEND_GAP_MS,
} from "./heartbeat.ts";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sable-hb-"));
}

test("catchUpOn: SABLE_CATCHUP=0 disables; default on", () => {
  assert.equal(catchUpOn({}), true);
  assert.equal(catchUpOn({ SABLE_CATCHUP: "0" }), false);
  assert.equal(catchUpOn({ SABLE_ROUTINE_CATCHUP: "0" }), false);
  assert.equal(catchUpOn({ SABLE_CATCHUP: "1", SABLE_ROUTINE_CATCHUP: "0" }), true);
});

test("tickHeartbeat: first tick no wake; large gap marks suspend", () => {
  const dir = tmp();
  const t0 = 1_000_000;
  const a = tickHeartbeat(dir, t0, { pid: 1 });
  assert.equal(a.wokeFromSuspend, undefined);
  assert.equal(readHeartbeat(dir)?.lastTickAt, t0);
  const a2 = tickHeartbeat(dir, t0 + 10_000, { pid: 1 });
  assert.equal(a2.wokeFromSuspend, undefined);
  const woke = tickHeartbeat(dir, t0 + 10_000 + DEFAULT_SUSPEND_GAP_MS, { pid: 2 });
  assert.equal(woke.wokeFromSuspend, true);
  assert.ok((woke.lastGapMs ?? 0) >= DEFAULT_SUSPEND_GAP_MS);
  const snap = healthSnapshot(dir, { SABLE_CATCHUP: "1" }, woke.lastTickAt);
  assert.equal(snap.catchUpEnabled, true);
  assert.equal(snap.heartbeat?.wokeFromSuspend, true);
});
