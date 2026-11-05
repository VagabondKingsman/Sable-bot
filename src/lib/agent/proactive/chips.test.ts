import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { assertNoSend, chipsFor, CHIP_ROUTES, type Chip } from "./chips.ts";
import type { UnifiedTask } from "./unify.ts";

const task = (over: Partial<UnifiedTask>): UnifiedTask => ({ id: "t", kind: "triage", title: "Hợp đồng", detail: "", state: "todo", at: 1, ref: {}, ...over });

test("chips: approval ask gets approve/reject with confirm; reply gets a draft; triage gets snooze/done", () => {
  const ask = chipsFor(task({ kind: "approval", state: "waiting_approval", ref: { approvalId: "ap1", jobId: "j1", triageId: "i1" } }));
  assert.deepEqual(ask.map((c) => c.action), ["approve", "reject", "open_job"]);
  assert.ok(ask.filter((c) => c.action === "approve" || c.action === "reject").every((c) => c.confirm));
  const reply = chipsFor(task({ bucket: "needs_reply", ref: { triageId: "m1" } }));
  assert.deepEqual(reply.map((c) => c.action), ["draft_reply", "snooze", "snooze", "done"]);
  assert.match(reply[0].draft!, /Hợp đồng/);
  assert.deepEqual(chipsFor(task({ kind: "plan", ref: { planId: "p1" } })).map((c) => c.action), ["open_task"]);
  assert.deepEqual(chipsFor(task({ state: "done", bucket: "needs_reply", ref: { triageId: "x" } })), []);
});

test("chip never sends: no send action, sends:false, no route reaches a channel", () => {
  const all: Chip[] = [
    ...chipsFor(task({ kind: "approval", state: "waiting_approval", ref: { approvalId: "a", stepId: "s", planId: "p" } })),
    ...chipsFor(task({ bucket: "needs_reply", ref: { triageId: "m", jobId: "j" } })),
  ];
  assertNoSend(all);
  for (const c of all) assert.equal(c.sends, false);
  for (const [action, route] of Object.entries(CHIP_ROUTES)) {
    assert.doesNotMatch(String(route), /channel|telegram|webhook|smtp|send/i, `${action} route`);
  }
  assert.throws(() => assertNoSend([{ ...all[0], sends: true as unknown as false }]));
  assert.throws(() => assertNoSend([{ ...all[0], action: "send" as never }]));
  assert.throws(() => assertNoSend([{ ...all[0], label: "Send reply" }]));
});

test("chip UI has no send path: ChipRow only calls decide / tasks / triage / clipboard", () => {
  const src = fs.readFileSync(new URL("../../../components/sable/proactive-panel.tsx", import.meta.url), "utf8");
  const row = src.slice(src.indexOf("export function ChipRow"));
  assert.doesNotMatch(row, /\/api\/channels|\/api\/webhook|notifyOwnerTelegram|channel_send|fetch\(/);
  assert.match(row, /window\.confirm/);
  assert.match(row, /không tự gửi/);
});
