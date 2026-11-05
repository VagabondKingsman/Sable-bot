import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BudgetMeter } from "./meter.ts";
import { pickModel, readRouterConfig } from "./router.ts";
import { estimateUsd } from "./prices.ts";

test("budget: meter + fail-closed trip + kill switch meters only", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sable-bud-"));
  const meter = new BudgetMeter(dir, { SABLE_BUDGET: "1", SABLE_BUDGET_MAX_TOKENS: "100" });
  meter.record({ scope: "chat", scopeId: "c1", model: "grok-4.7", promptTokens: 60, completionTokens: 50 });
  assert.equal(meter.check().ok, false);
  const soft = new BudgetMeter(dir, { SABLE_BUDGET: "0", SABLE_BUDGET_MAX_TOKENS: "100" });
  assert.equal(soft.check().ok, true);
  assert.ok(estimateUsd("grok-4.7", 1_000_000, 0) > 0);
});

test("budget: plan caps + router D8", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sable-bud-"));
  const meter = new BudgetMeter(dir, { SABLE_BUDGET: "1" });
  const plan = { usedTokens: 90, usedUsd: 0.01, budgetTokens: 100 };
  assert.equal(meter.checkPlan(plan, 5).ok, true);
  assert.equal(meter.checkPlan(plan, 20).ok, false);

  const cfg = readRouterConfig({
    SABLE_MODEL_HARD: "grok-4.7",
    SABLE_MODEL_LIGHT: "gpt-4.1-mini",
  });
  assert.equal(cfg.hardModel, "grok-4.7");
  assert.equal(pickModel("hard", { SABLE_MODEL_HARD: "grok-4.7", SABLE_MODEL_LIGHT: "gpt-4.1-mini" }), "grok-4.7");
  assert.equal(pickModel("light", { SABLE_MODEL_HARD: "grok-4.7", SABLE_MODEL_LIGHT: "gpt-4.1-mini" }), "gpt-4.1-mini");
  assert.equal(pickModel("light", { SABLE_MODEL_ROUTER: "0", SABLE_MODEL_HARD: "grok-4.7", SABLE_MODEL_LIGHT: "gpt-4.1-mini" }), "grok-4.7");
  fs.rmSync(dir, { recursive: true, force: true });
});
