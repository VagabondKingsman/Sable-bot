import test from "node:test";
import assert from "node:assert/strict";
import { planState, stateCounts, unify } from "./unify.ts";
import type { TriagedItem } from "./feed.ts";

const tri = (id: string, bucket: TriagedItem["result"]["bucket"], extra: Partial<TriagedItem> = {}, meta: Record<string, string> = {}): TriagedItem => ({
  input: { id, source: "inbox", title: id, body: "b", at: 10, meta: { kind: bucket === "needs_approval" ? "approval" : "result", ...meta } },
  result: { bucket, urgency: "normal", reason: "r", decidedBy: "rule:x" },
  state: null,
  snoozed: false,
  ...extra,
});

test("plan status → task state", () => {
  assert.deepEqual(["draft", "running", "waiting_approval", "paused", "done", "failed"].map(planState), ["todo", "doing", "waiting_approval", "todo", "done", "done"]);
});

test("unify merges plans, step approvals, triaged items and active jobs into four states", () => {
  const tasks = unify({
    plans: [{ id: "p1", goal: "Report", status: "waiting_approval", updatedAt: 5, steps: [{ id: "s1", title: "write", status: "waiting_approval", approvalId: "ap-s" }, { id: "s0", title: "read", status: "done" }] }],
    triaged: [
      tri("a1", "needs_approval", {}, { approvalId: "ap1", jobId: "j1" }),
      tri("r1", "needs_reply"),
      tri("f1", "fyi", { state: { done: true, at: 1 } }),
      tri("g1", "ignore"),
      tri("z1", "needs_reply", { snoozed: true }),
    ],
    jobs: [{ id: "j1", title: "has ask", status: "running", createdAt: 1 }, { id: "j2", title: "busy", status: "running", createdAt: 2 }, { id: "j3", title: "old", status: "done", createdAt: 3 }],
  });
  const ids = tasks.map((t) => t.id);
  assert.ok(ids.includes("plan:p1") && ids.includes("step:p1:s1") && ids.includes("triage:a1") && ids.includes("triage:r1") && ids.includes("job:j2"));
  assert.ok(!ids.includes("triage:g1"), "ignored items hidden");
  assert.ok(!ids.includes("triage:z1"), "snoozed hidden by default");
  assert.ok(!ids.includes("job:j1"), "job already represented by its ask");
  assert.ok(!ids.includes("job:j3"));
  assert.deepEqual(stateCounts(tasks), { waiting_approval: 3, todo: 1, doing: 1, done: 1 });
  assert.equal(tasks[0].state, "waiting_approval", "asks sort first");
  assert.equal(tasks.find((t) => t.id === "triage:a1")?.ref.approvalId, "ap1");
  assert.ok(unify({ plans: [], triaged: [tri("z1", "needs_reply", { snoozed: true })], jobs: [], includeSnoozed: true }).length === 1);
});
