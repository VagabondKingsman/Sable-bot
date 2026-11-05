import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateGraph } from "./graph.ts";
import { PlanExecutor, simulateCrash } from "./executor.ts";
import { PlanStore } from "./store.ts";
import type { PlanStep } from "./types.ts";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sable-plan-"));
}

test("graph: cycle detect + ready refresh", () => {
  const steps: PlanStep[] = [
    { id: "a", title: "A", kind: "note", deps: ["b"], status: "pending", requiresApproval: false },
    { id: "b", title: "B", kind: "note", deps: ["a"], status: "pending", requiresApproval: false },
  ];
  assert.equal(validateGraph(steps).ok, false);
  const ok: PlanStep[] = [
    { id: "a", title: "A", kind: "note", deps: [], status: "pending", requiresApproval: false },
    { id: "b", title: "B", kind: "note", deps: ["a"], status: "pending", requiresApproval: false },
  ];
  assert.equal(validateGraph(ok).ok, true);
});

test("planner: create → tick → write_gate waits → approve → done; resume after crash", async () => {
  const dir = tmp();
  const store = new PlanStore(dir, {});
  const created = store.create({
    goal: "doc audit own files",
    steps: [
      { id: "s1", title: "outline", kind: "note" },
      { id: "s2", title: "classify", kind: "classify", deps: ["s1"], difficulty: "light" },
      { id: "s3", title: "write report", kind: "write_gate", deps: ["s2"], requiresApproval: true },
      { id: "s4", title: "wrap", kind: "note", deps: ["s3"] },
    ],
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const ex = new PlanExecutor(store, {}, {});
  assert.equal(ex.start(created.plan.id).ok, true);
  const t1 = await ex.tick(created.plan.id);
  assert.equal(t1.ok, true);
  if (!t1.ok) return;
  assert.equal(t1.plan.status, "waiting_approval");
  assert.equal(t1.plan.steps.find((s) => s.id === "s3")?.status, "waiting_approval");

  // Simulate crash mid-wait: persist running state then resume
  const crashed = simulateCrash(t1.plan);
  // Force a running step as if crash during s4 attempt — here keep waiting
  store.save(crashed);
  const resumed = ex.resume(created.plan.id);
  assert.equal(resumed.ok, true);

  assert.equal(ex.approveStep(created.plan.id, "s3", true).ok, true);
  const t2 = await ex.tick(created.plan.id);
  assert.equal(t2.ok, true);
  if (!t2.ok) return;
  assert.equal(t2.plan.status, "done");
  assert.ok(t2.plan.checkpoint?.completedStepIds.includes("s4"));
});

test("planner: kill switch + deny write_gate", async () => {
  const dir = tmp();
  const store = new PlanStore(dir, { SABLE_PLANNER: "0" });
  const denied = store.create({ goal: "x", steps: [{ title: "a" }] });
  assert.equal(denied.ok, false);

  const store2 = new PlanStore(dir, {});
  const created = store2.create({
    goal: "g",
    steps: [
      { id: "a", title: "a", kind: "note" },
      { id: "b", title: "b", kind: "write_gate", deps: ["a"], requiresApproval: true },
    ],
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  const ex = new PlanExecutor(store2);
  await ex.start(created.plan.id);
  await ex.tick(created.plan.id);
  const deniedStep = ex.approveStep(created.plan.id, "b", false);
  assert.equal(deniedStep.ok, true);
  assert.equal(deniedStep.plan?.status, "failed");
});

test("planner: pause / resume / cancel", async () => {
  const store = new PlanStore(tmp(), {});
  const created = store.create({
    goal: "g",
    steps: [
      { id: "a", title: "a", kind: "note" },
      { id: "b", title: "b", kind: "note", deps: ["a"] },
    ],
  });
  if (!created.ok) return;
  const ex = new PlanExecutor(store);
  ex.start(created.plan.id);
  assert.equal(ex.pause(created.plan.id).ok, true);
  assert.equal(store.get(created.plan.id)?.status, "paused");
  assert.equal(ex.resume(created.plan.id).ok, true);
  await ex.tick(created.plan.id);
  assert.equal(store.get(created.plan.id)?.status, "done");
  const c2 = store.create({ goal: "c", steps: [{ title: "x" }] });
  if (!c2.ok) return;
  ex.start(c2.plan.id);
  assert.equal(ex.cancel(c2.plan.id).ok, true);
  assert.equal(store.get(c2.plan.id)?.status, "cancelled");
});
