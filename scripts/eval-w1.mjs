/**
 * W1 eval: planner create/resume after crash, workspace isolation, budget trip, scope decide path.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PlanStore } from "../src/lib/agent/planner/store.ts";
import { PlanExecutor, simulateCrash } from "../src/lib/agent/planner/executor.ts";
import { WorkspaceStore } from "../src/lib/agent/workspace/store.ts";
import { BudgetMeter } from "../src/lib/agent/budget/meter.ts";
import { pickModel } from "../src/lib/agent/budget/router.ts";
import { ScopeStore } from "../src/lib/agent/scope/store.ts";

function pass(name) {
  console.log("PASS", name);
}
function fail(name, err) {
  console.error("FAIL", name, err);
  process.exitCode = 1;
}

async function planResume() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-plan-"));
  const store = new PlanStore(dir, {});
  const created = store.create({
    goal: "research notes",
    steps: [
      { id: "a", title: "outline", kind: "note" },
      { id: "b", title: "gate", kind: "write_gate", deps: ["a"], requiresApproval: true },
      { id: "c", title: "done", kind: "note", deps: ["b"] },
    ],
  });
  assert.equal(created.ok, true);
  const ex = new PlanExecutor(store);
  ex.start(created.plan.id);
  await ex.tick(created.plan.id);
  const mid = store.get(created.plan.id);
  assert.equal(mid.status, "waiting_approval");
  const crashed = simulateCrash(mid);
  store.save(crashed);
  assert.equal(ex.resume(created.plan.id).ok, true);
  ex.approveStep(created.plan.id, "b", true);
  const fin = await ex.tick(created.plan.id);
  assert.equal(fin.ok, true);
  assert.equal(fin.plan.status, "done");
  pass("plan-create-resume-after-crash");
}

function workspaceIsolation() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "eval-ws-"));
  const store = new WorkspaceStore("/tmp/fallback", { SABLE_TASK_WORKSPACE_ROOT: root });
  for (const id of ["t1", "t2", "t3"]) {
    const info = store.ensure(id);
    fs.writeFileSync(path.join(info.root, "artifacts", "x.txt"), id);
  }
  assert.equal(fs.readFileSync(path.join(root, "t1", "artifacts", "x.txt"), "utf8"), "t1");
  assert.equal(fs.readFileSync(path.join(root, "t2", "artifacts", "x.txt"), "utf8"), "t2");
  assert.equal(fs.readFileSync(path.join(root, "t3", "artifacts", "x.txt"), "utf8"), "t3");
  pass("workspace-isolation-3");
}

function budgetTrip() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-bud-"));
  const meter = new BudgetMeter(dir, { SABLE_BUDGET: "1", SABLE_BUDGET_MAX_USD: "0.00001" });
  meter.record({ scope: "job", scopeId: "j1", model: "grok-4.7", promptTokens: 100_000, completionTokens: 100_000 });
  assert.equal(meter.check().ok, false);
  assert.equal(pickModel("hard", { SABLE_MODEL_HARD: "grok-4.7" }), "grok-4.7");
  pass("budget-trip");
}

function scopeCardPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eval-scope-"));
  const store = new ScopeStore(dir);
  const rec = store.create({ target: "/workspace/sable-workspace/tasks/demo", purpose: "doc-audit own files", owner: "owner" });
  assert.equal(rec.status, "pending");
  // Same path as /api/tools kind=scope
  const decided = store.decide(rec.id, "approved", rec.id);
  assert.equal(decided?.status, "approved");
  const denied = store.create({ target: "x", purpose: "y", owner: "owner" });
  assert.equal(store.decide(denied.id, "denied", denied.id)?.status, "denied");
  pass("scope-card-approve-deny");
}

await planResume().catch((e) => fail("plan-create-resume-after-crash", e));
try {
  workspaceIsolation();
} catch (e) {
  fail("workspace-isolation-3", e);
}
try {
  budgetTrip();
} catch (e) {
  fail("budget-trip", e);
}
try {
  scopeCardPath();
} catch (e) {
  fail("scope-card-approve-deny", e);
}

if (!process.exitCode) console.log("\nall w1 eval checks passed");
