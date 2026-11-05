import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { exportTrace, filterByTool, fromChat, fromJob, fromPlan, isTraceExport, msFromDetail, validTraceId } from "./build.ts";
import { TraceArchive, retainDays } from "./archive.ts";
import type { Job } from "../jobs/types.ts";
import type { TaskPlan } from "../planner/types.ts";

function job(over: Partial<Job> = {}): Job {
  const now = Date.now();
  return {
    id: "j1",
    title: "nightly digest",
    kind: "agent",
    status: "done",
    request: { model: "grok-4.7" } as Job["request"],
    maxSteps: 8,
    timeoutMs: 60_000,
    createdAt: now - 5000,
    updatedAt: now,
    startedAt: now - 4000,
    finishedAt: now,
    usedMs: 4000,
    attempts: 1,
    text: "ok",
    steps: [
      { id: "tool-1-a", kind: "tool", label: "fs_read · a.md", tool: "fs_read", at: now - 3900, ms: 12, state: "done", detail: "ok · 12 ms\nhello" },
      { id: "tool-1-b", kind: "tool", label: "spawn_agent · research", tool: "spawn_agent", at: now - 3800, ms: 2000, state: "done", detail: "ok · 2000 ms" },
      { id: "tool-1-b~tool-1-c", kind: "tool", label: "http_fetch · x", tool: "http_fetch", parent: "tool-1-b", state: "done", detail: "lỗi · 30 ms\nblocked" },
      { id: "tool-2-d", kind: "tool", label: "fs_write · out.md (old record)", state: "done", detail: "ok · 40 ms\nkey sk-abcdefghijklmnopqrstuvwxyz0123456789" },
    ],
    approvals: [{ id: "ap1", tool: "fs_write", summary: "write out.md", state: "approved" }],
    notices: [],
    citations: [],
    ...over,
  };
}

test("trace: job → timeline with tools, sub-agent, approval, latency, redaction", () => {
  const t = fromJob(job());
  assert.equal(t.id, "job.j1");
  assert.equal(t.source, "job");
  assert.equal(t.model, "grok-4.7");
  assert.equal(t.durationMs, 4000);
  assert.equal(t.stats.toolCalls, 4);
  assert.equal(t.stats.subAgents, 1);
  assert.equal(t.stats.approvals, 1);
  assert.equal(t.stats.errors, 1);
  assert.equal(t.stats.tools.fs_read, 1);
  const old = t.events.find((e) => e.id === "tool-2-d")!;
  assert.equal(old.ms, 40, "ms parsed from pre-W2 detail");
  assert.ok(!old.detail!.includes("sk-abcdefghijklmnop"), "secrets redacted in trace detail");
  assert.equal(t.events.find((e) => e.id === "tool-1-b")!.type, "subagent");
  assert.equal(msFromDetail("ok · 77 ms\nx"), 77);
});

test("trace: filter by tool keeps sub-agent children", () => {
  const t = filterByTool(fromJob(job()), "spawn_agent");
  assert.deepEqual(t.events.map((e) => e.id), ["tool-1-b", "tool-1-b~tool-1-c"]);
  assert.equal(t.stats.subAgents, 1);
});

test("trace: export shape sable.trace.v1", () => {
  const doc = exportTrace(fromJob(job()), 123);
  assert.equal(doc.schema, "sable.trace.v1");
  assert.equal(doc.exportedAt, 123);
  assert.ok(isTraceExport(JSON.parse(JSON.stringify(doc))));
  assert.equal(isTraceExport({ schema: "x" }), false);
});

test("trace: plan + chat converters", () => {
  const now = Date.now();
  const plan = {
    id: "p1", goal: "audit docs", status: "waiting_approval", workspaceId: "p1", createdAt: now, updatedAt: now,
    maxSteps: 10, timeoutMs: 1000, usedTokens: 0, usedUsd: 0,
    steps: [
      { id: "s1", title: "classify", kind: "classify", deps: [], status: "done", requiresApproval: false, startedAt: now, finishedAt: now + 5 },
      { id: "s2", title: "write", kind: "write_gate", deps: ["s1"], status: "waiting_approval", requiresApproval: true },
    ],
  } as TaskPlan;
  const pt = fromPlan(plan);
  assert.equal(pt.id, "plan.p1");
  assert.equal(pt.stats.approvalsPending, 1);
  assert.equal(pt.events[0]!.ms, 5);
  const ct = fromChat("th1", "hello", { id: "m1", role: "assistant", content: "x", startedAt: now, finishedAt: now + 10, steps: [{ id: "s", kind: "web", label: "search", state: "done" }] }, now);
  assert.equal(ct!.id, "chat.th1.m1");
  assert.equal(ct!.stats.toolCalls, 1);
  assert.equal(fromChat("th1", "x", { id: "m2", role: "assistant", content: "plain" }, now), null);
  assert.equal(validTraceId("chat.th1.m1"), true);
  assert.equal(validTraceId("job.../x"), false);
  assert.equal(validTraceId("job.a.b"), false);
});

test("trace: archive keeps >= 7 days, prunes older, files 0600", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sable-trace-"));
  const archive = new TraceArchive(dir);
  const now = Date.now();
  assert.equal(archive.upsert(fromJob(job({ status: "running", finishedAt: undefined }))), false, "running traces are not archived");
  const fixed = job();
  assert.equal(archive.upsert(fromJob(fixed)), true);
  assert.equal(archive.upsert(fromJob(fixed)), false, "unchanged → no rewrite");
  const sixDays = fromJob(job({ id: "j6", finishedAt: now - 6 * 86_400_000, updatedAt: now - 6 * 86_400_000 }));
  const twentyDays = fromJob(job({ id: "j20", finishedAt: now - 20 * 86_400_000, updatedAt: now - 20 * 86_400_000 }));
  archive.upsert(sixDays);
  archive.upsert(twentyDays);
  const mode = fs.statSync(path.join(dir, "traces", "job.j1.json")).mode & 0o777;
  assert.equal(mode, 0o600);
  // Even an aggressive setting never drops below 7 days.
  const removed = archive.prune(now, 1);
  assert.equal(removed, 1);
  assert.ok(archive.get("job.j6"), "6-day-old trace kept");
  assert.equal(archive.get("job.j20"), null);
  assert.equal(retainDays({ SABLE_TRACE_RETAIN_DAYS: "2" }), 7);
  assert.equal(retainDays({}), 14);
  const fresh = new TraceArchive(dir);
  assert.deepEqual(fresh.ids().sort(), ["job.j1", "job.j6"]);
});
