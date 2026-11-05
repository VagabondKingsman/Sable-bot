/**
 * Phase 2 deep re-test: adversarial cases and one regression test per bug
 * fixed after the build pass (see the "regression:" titles).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { minGap, nextCron, parseCron } from "./jobs/cron.ts";
import { claimDataDir, JobDb, MAX_FINISHED_JOBS, MAX_INBOX } from "./jobs/db.ts";
import { deliverApproval, deliverResult, settleApproval, unreadCount } from "./jobs/inbox.ts";
import { compactRequest, JobRunner, type JobExec } from "./jobs/runner.ts";
import { RoutineRefusal, RoutineScheduler, parseRoutineInput, requestFor } from "./jobs/scheduler.ts";
import { nextRun, planDue, validateSchedule } from "./jobs/schedule.ts";
import { summarize, type Job } from "./jobs/types.ts";
import { createApprovals } from "./tools/approvals.ts";
import { execute } from "./tools/execute.ts";
import { fsWrite } from "./tools/fs.ts";
import type { ChatRequest } from "./types.ts";
import { readJsonBody, readObjectBody } from "../../server/http.ts";

const SGN = "Asia/Saigon";
const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (text: string) => Date.parse(text);
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "sable-deep-"));

const request = (text = "do it", extra: Partial<ChatRequest> = {}): ChatRequest => ({
  model: "grok-4.7",
  effort: "high",
  instructions: "",
  memory: "",
  messages: [{ role: "user", content: text }],
  tools: { web: false, x: false, code: false, image: false, files: true, fetch: false },
  ...extra,
});

function runnerWith(exec: JobExec, extra: Partial<ConstructorParameters<typeof JobRunner>[0]> = {}, dir = tmpDir()) {
  const db = new JobDb(dir);
  const runner = new JobRunner({
    db,
    exec,
    flushMs: 5,
    onFinish: (job) => deliverResult(db, job),
    onWaiting: (job, approval) => deliverApproval(db, job, approval),
    onApprovalSettled: (job, approval) => settleApproval(db, job, approval),
    ...extra,
  });
  return { db, runner, dir };
}

const waitFor = async (check: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await sleep(3);
  }
};

function gate() {
  const releases = new Map<string, () => void>();
  const started: string[] = [];
  let live = 0;
  let peak = 0;
  const exec: JobExec = (job, io) =>
    new Promise((resolve, reject) => {
      started.push(job.title);
      live += 1;
      peak = Math.max(peak, live);
      releases.set(job.id, () => {
        live -= 1;
        releases.delete(job.id);
        resolve();
      });
      io.signal.addEventListener("abort", () => {
        live -= 1;
        releases.delete(job.id);
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  return { exec, releases, started, peak: () => peak };
}

/** Exec that asks for one write approval and records the answer. */
function asker(answers: Map<string, boolean>) {
  const exec: JobExec = async (job, io) => {
    const ok = await io.approve({ tool: "fs_write", summary: `Ghi ${job.title}` });
    answers.set(job.id, ok);
    io.emit({ event: "delta", data: { text: ok ? "đã ghi" : "không ghi" } });
  };
  return exec;
}
const pendingId = (db: JobDb, id: string) =>
  db.getJob(id)?.approvals.find((item) => item.state === "pending")?.id ?? "";

// ---------- concurrency & races ----------

test("deep: 7 jobs with concurrency 2 → never more than 2 live, strict FIFO start order", async () => {
  const g = gate();
  const { runner, db } = runnerWith(g.exec, { concurrency: 2 });
  const ids = [1, 2, 3, 4, 5, 6, 7].map((n) => runner.enqueue({ title: `j${n}`, request: request(), maxSteps: 3, timeoutMs: 60_000 }).id);
  while (db.listJobs().some((job) => job.status !== "done")) {
    await waitFor(() => g.releases.size > 0 || db.listJobs().every((job) => job.status === "done"));
    assert.ok(runner.running() <= 2);
    const first = [...g.releases.values()][0];
    first?.();
    await sleep(2);
  }
  await runner.idle();
  assert.equal(g.peak(), 2);
  assert.deepEqual(g.started, ["j1", "j2", "j3", "j4", "j5", "j6", "j7"]);
  assert.ok(ids.every((id) => db.getJob(id)?.status === "done"));
});

test("regression: jobs created in the same millisecond keep FIFO order after a restart", async () => {
  const dir = tmpDir();
  const g = gate();
  const first = runnerWith(g.exec, { concurrency: 1, now: () => 1_000 }, dir);
  first.runner.enqueue({ title: "blocker", request: request(), maxSteps: 3, timeoutMs: 60_000 });
  for (const n of [1, 2, 3, 4, 5, 6]) first.runner.enqueue({ title: `j${n}`, request: request(), maxSteps: 3, timeoutMs: 60_000 });
  const created = first.db.listJobs().map((job) => job.createdAt);
  assert.equal(new Set(created).size, 7, "creation times are strictly increasing");
  // the process dies with j1..j6 queued; the blocker is requeued after them? no: it is older, so first.
  const order: string[] = [];
  const again = runnerWith(async (job) => void order.push(job.title), { concurrency: 1 }, dir);
  again.runner.recover();
  again.runner.pump();
  await again.runner.idle();
  assert.deepEqual(order, ["blocker", "j1", "j2", "j3", "j4", "j5", "j6"]);
  for (const release of g.releases.values()) release();
});

test("deep: cancel queued vs running vs waiting_approval, double cancel, cancel after done", async () => {
  const answers = new Map<string, boolean>();
  const { runner, db } = runnerWith(asker(answers), { concurrency: 1 });
  const waiting = runner.enqueue({ title: "w", request: request(), maxSteps: 3, timeoutMs: 60_000 });
  const queued = runner.enqueue({ title: "q", request: request(), maxSteps: 3, timeoutMs: 60_000 });
  await waitFor(() => db.getJob(waiting.id)?.status === "waiting_approval");
  assert.equal(db.getJob(queued.id)?.status, "queued");
  assert.equal(runner.cancel(queued.id), true);
  assert.equal(runner.cancel(queued.id), false, "double cancel of a finished-cancelled job");
  assert.equal(runner.cancel(waiting.id), true);
  assert.equal(runner.cancel(waiting.id), true, "double cancel while stopping is harmless");
  await runner.idle();
  assert.equal(db.getJob(waiting.id)?.status, "cancelled");
  assert.equal(db.getJob(queued.id)?.status, "cancelled");
  assert.equal(answers.get(waiting.id), false, "the write was never approved");
  assert.equal(runner.cancel(waiting.id), false);
  assert.equal(runner.cancel("job_nope"), false);
});

test("regression: cancelling a job that waits for approval clears its unread approval ask (badge stays accurate)", async () => {
  const { runner, db } = runnerWith(asker(new Map()));
  const job = runner.enqueue({ request: request(), maxSteps: 3, timeoutMs: 60_000 });
  await waitFor(() => db.getJob(job.id)?.status === "waiting_approval");
  assert.equal(unreadCount(db), 1);
  runner.cancel(job.id);
  await runner.idle();
  assert.equal(unreadCount(db), 0);
  assert.equal(db.inbox().filter((item) => item.kind === "result").length, 0, "cancelled → no result entry");
});

test("deep: approve twice, approve + cancel in the same tick, forged and cross-job approval ids", async () => {
  const answers = new Map<string, boolean>();
  const { runner, db } = runnerWith(asker(answers), { concurrency: 3 });
  const a = runner.enqueue({ title: "a", request: request(), maxSteps: 3, timeoutMs: 60_000 });
  const b = runner.enqueue({ title: "b", request: request(), maxSteps: 3, timeoutMs: 60_000 });
  const c = runner.enqueue({ title: "c", request: request(), maxSteps: 3, timeoutMs: 60_000 });
  await waitFor(() => [a, b, c].every((job) => db.getJob(job.id)?.status === "waiting_approval"));
  const idA = pendingId(db, a.id);
  const idB = pendingId(db, b.id);
  const idC = pendingId(db, c.id);
  assert.equal(runner.decide("forged-" + idA, true), false);
  assert.equal(runner.decide("", true), false);
  assert.equal(runner.decide(idA, true), true);
  assert.equal(runner.decide(idA, true), false, "second approval of the same id is refused");
  assert.equal(runner.decide(idA, false), false, "and cannot flip it to a rejection");
  // b's id answers b only; c is untouched
  assert.equal(runner.decide(idB, false), true);
  // approve and cancel c in the same tick: cancel wins over nothing, approve wins only if first
  runner.cancel(c.id);
  assert.equal(runner.decide(idC, true), false, "approval after cancel is gone");
  await runner.idle();
  assert.equal(answers.get(a.id), true);
  assert.equal(answers.get(b.id), false);
  assert.equal(db.getJob(a.id)?.status, "done");
  assert.equal(db.getJob(b.id)?.status, "done");
  assert.equal(db.getJob(c.id)?.status, "cancelled");
  assert.notEqual(answers.get(c.id), true, "the cancelled job never got an approval");
});

test("deep: approving after expiry is refused and the job carried on without the write", async () => {
  const answers = new Map<string, boolean>();
  const { runner, db } = runnerWith(asker(answers), { approvalTtlMs: 30 });
  const job = runner.enqueue({ request: request(), maxSteps: 3, timeoutMs: 60_000 });
  await waitFor(() => db.getJob(job.id)?.status === "waiting_approval");
  const id = pendingId(db, job.id);
  await runner.idle();
  assert.equal(runner.decide(id, true), false);
  assert.equal(answers.get(job.id), false);
  assert.equal(db.getJob(job.id)?.approvals[0]?.state, "expired");
  assert.equal(db.getJob(job.id)?.status, "done");
});

test("regression: an approval asked on an already-aborted run returns false at once and shows no card", async () => {
  const approvals = createApprovals(60_000);
  const controller = new AbortController();
  controller.abort();
  const events: string[] = [];
  const started = Date.now();
  const ok = await approvals.request({ tool: "fs_write", summary: "x" }, (event) => events.push(event.event), controller.signal);
  assert.equal(ok, false);
  assert.ok(Date.now() - started < 50);
  assert.deepEqual(events, []);
  assert.equal(approvals.pending(), 0);
});

test("regression: an approved write does not run if the job was cancelled before it executed", async () => {
  const root = tmpDir();
  const controller = new AbortController();
  const out = await execute(fsWrite, JSON.stringify({ path: "late.txt", content: "x" }), {
    workspaceDir: root,
    signal: controller.signal,
    mode: "background",
    approve: async () => {
      controller.abort(); // cancel lands while the approval resolves
      return true;
    },
  });
  assert.equal(out.ok, false);
  assert.equal(fs.existsSync(path.join(root, "late.txt")), false);
});

test("regression: an exec that ignores cancel is closed after the grace period and frees its slot", async () => {
  const order: string[] = [];
  let calls = 0;
  const exec: JobExec = (job) => {
    calls += 1;
    order.push(job.title);
    return calls === 1 ? new Promise(() => {}) : Promise.resolve();
  };
  const { runner, db } = runnerWith(exec, { concurrency: 1, abortGraceMs: 40 });
  const stuck = runner.enqueue({ title: "stuck", request: request(), maxSteps: 3, timeoutMs: 60_000 });
  const next = runner.enqueue({ title: "next", request: request(), maxSteps: 3, timeoutMs: 60_000 });
  await waitFor(() => db.getJob(stuck.id)?.status === "running");
  runner.cancel(stuck.id);
  await runner.idle();
  assert.equal(db.getJob(stuck.id)?.status, "cancelled");
  assert.equal(db.getJob(next.id)?.status, "done");
  // the timeout path has the same guard
  const hung = runnerWith(() => new Promise(() => {}), { abortGraceMs: 20 });
  const timed = hung.runner.enqueue({ request: request(), maxSteps: 3, timeoutMs: 30 });
  await hung.runner.idle();
  assert.equal(hung.db.getJob(timed.id)?.status, "failed");
  assert.match(hung.db.getJob(timed.id)?.error ?? "", /Quá thời gian/);
});

// ---------- limits ----------

test("deep: step cap, wall-clock timeout and an upstream error mid-job end cleanly with an inbox entry", async () => {
  const seen: number[] = [];
  const exec: JobExec = async (job, io) => {
    seen.push(job.maxSteps);
    if (job.title === "boom") {
      io.emit({ event: "delta", data: { text: "nửa chừng" } });
      throw new Error("xAI 503: upstream unavailable");
    }
    if (job.title === "slow") await new Promise((_, reject) => io.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    return { stopped: "max_steps" as const };
  };
  const { runner, db } = runnerWith(exec, { concurrency: 3 });
  const capped = runner.enqueue({ title: "cap", request: request(), maxSteps: 4, timeoutMs: 60_000 });
  const boom = runner.enqueue({ title: "boom", request: request(), maxSteps: 4, timeoutMs: 60_000 });
  const slow = runner.enqueue({ title: "slow", request: request(), maxSteps: 4, timeoutMs: 40 });
  await runner.idle();
  assert.deepEqual(seen, [4, 4, 4]);
  assert.equal(db.getJob(capped.id)?.stopped, "max_steps");
  assert.equal(db.getJob(capped.id)?.status, "done");
  assert.equal(db.getJob(boom.id)?.status, "failed");
  assert.match(db.getJob(boom.id)?.error ?? "", /503/);
  assert.equal(db.getJob(slow.id)?.status, "failed");
  const inbox = db.inbox();
  assert.equal(inbox.length, 3);
  assert.ok(inbox.some((item) => item.jobId === capped.id && /giới hạn bước/.test(item.snippet)));
});

// ---------- persistence ----------

test("regression: a job file that is valid JSON but the wrong shape no longer crashes startup", () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, "jobs"));
  fs.writeFileSync(path.join(dir, "jobs", "job_x.json"), JSON.stringify({ id: "job_x", status: "running" }));
  fs.writeFileSync(path.join(dir, "jobs", "job_trunc.json"), '{"id":"job_trunc","status":"runn');
  fs.writeFileSync(path.join(dir, "routines.json"), JSON.stringify([null, { id: "r" }, 5]));
  fs.writeFileSync(path.join(dir, "inbox.json"), JSON.stringify({ not: "a list" }));
  const { runner, db } = runnerWith(async () => undefined, {}, dir);
  assert.deepEqual(runner.recover(), { requeued: 0, failed: 0, cancelled: 0 });
  assert.equal(db.listJobs().length, 0);
  assert.deepEqual(db.routines(), []);
  assert.deepEqual(db.inbox(), []);
  const names = fs.readdirSync(path.join(dir, "jobs"));
  assert.ok(names.some((name) => name.startsWith("job_x.json.corrupt-")));
  assert.ok(names.some((name) => name.startsWith("job_trunc.json.corrupt-")));
  assert.ok(fs.readdirSync(dir).some((name) => name.startsWith("inbox.json.corrupt-")));
});

test("regression: a job whose file name does not match its id is set aside", () => {
  const dir = tmpDir();
  const seed = new JobDb(dir);
  const runner = new JobRunner({ db: seed, exec: async () => undefined });
  const job = runner.enqueue({ request: request(), maxSteps: 3, timeoutMs: 1_000 });
  fs.renameSync(path.join(dir, "jobs", `${job.id}.json`), path.join(dir, "jobs", "job_other.json"));
  const db = new JobDb(dir);
  assert.equal(db.listJobs().length, 0);
});

test("regression: an existing data dir with loose permissions is tightened to 700", () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, "jobs"), { mode: 0o777 });
  fs.chmodSync(dir, 0o755);
  fs.chmodSync(path.join(dir, "jobs"), 0o777);
  const db = new JobDb(dir);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, "jobs")).mode & 0o777, 0o700);
  db.saveRoutines([]);
  assert.equal(fs.statSync(path.join(dir, "routines.json")).mode & 0o777, 0o600);
});

test("regression: a failed disk write leaves no ghost job in memory (API said 500, nothing runs)", { skip: process.getuid?.() === 0 }, () => {
  const dir = tmpDir();
  const { runner, db } = runnerWith(async () => undefined, {}, dir);
  fs.chmodSync(path.join(dir, "jobs"), 0o500);
  try {
    assert.throws(() => runner.enqueue({ request: request(), maxSteps: 3, timeoutMs: 1_000 }));
    assert.equal(db.listJobs().length, 0);
  } finally {
    fs.chmodSync(path.join(dir, "jobs"), 0o700);
  }
  assert.equal(fs.readdirSync(path.join(dir, "jobs")).length, 0, "no temp file left behind");
});

test("regression: a job that finished right before a crash (inbox not written) is delivered on restart, once", async () => {
  const dir = tmpDir();
  const db = new JobDb(dir);
  const crashing = new JobRunner({
    db,
    exec: async (_job, io) => io.emit({ event: "delta", data: { text: "kết quả" } }),
    flushMs: 5,
    onFinish: () => {
      throw new Error("process died here");
    },
  });
  const job = crashing.enqueue({ request: request(), maxSteps: 3, timeoutMs: 60_000 });
  await crashing.idle();
  assert.equal(new JobDb(dir).getJob(job.id)?.delivered, false);
  for (let restart = 0; restart < 2; restart += 1) {
    const next = runnerWith(async () => undefined, {}, dir);
    next.runner.recover();
    assert.equal(next.db.inbox().filter((item) => item.jobId === job.id).length, 1, `restart ${restart}`);
    assert.equal(next.db.getJob(job.id)?.delivered, true);
  }
});

test("deep: restart at every state — queued, running mid-tool, waiting_approval, cancel requested", async () => {
  const dir = tmpDir();
  const g = gate();
  const first = runnerWith(g.exec, { concurrency: 1 }, dir);
  const running = first.runner.enqueue({ title: "r", request: request(), maxSteps: 3, timeoutMs: 60_000 });
  const queued = first.runner.enqueue({ title: "q", request: request(), maxSteps: 3, timeoutMs: 60_000 });
  await waitFor(() => first.db.getJob(running.id)?.status === "running");
  // process dies: nothing more from `first`
  const answers = new Map<string, boolean>();
  const second = runnerWith(asker(answers), { concurrency: 2 }, dir);
  assert.deepEqual(second.runner.recover(), { requeued: 1, failed: 0, cancelled: 0 });
  second.runner.pump();
  await waitFor(() => [running.id, queued.id].every((id) => second.db.getJob(id)?.status === "waiting_approval"));
  // dies again while both wait for approval → expired asks, rerun asks again (attempt limit 2 → running fails)
  const third = runnerWith(async () => undefined, {}, dir);
  const counts = third.runner.recover();
  assert.deepEqual(counts, { requeued: 1, failed: 1, cancelled: 0 });
  assert.equal(third.db.getJob(running.id)?.status, "failed");
  assert.ok(third.db.getJob(running.id)?.approvals.every((item) => item.state !== "pending"));
  third.runner.pump();
  await third.runner.idle();
  assert.equal(third.db.getJob(queued.id)?.status, "done");
  assert.ok(third.db.listJobs().every((job) => job.status === "done" || job.status === "failed"));
  for (const release of g.releases.values()) release();
});

test("deep: large history is capped (300 jobs, 300 inbox) and listing stays fast", async () => {
  const { runner, db } = runnerWith(async (_job, io) => io.emit({ event: "delta", data: { text: "x".repeat(2_000) } }), { concurrency: 8 });
  for (let index = 0; index < 360; index += 1)
    runner.enqueue({ title: `j${index}`, request: request("y".repeat(50_000)), maxSteps: 3, timeoutMs: 60_000 });
  await runner.idle();
  assert.ok(db.listJobs().length <= MAX_FINISHED_JOBS);
  assert.ok(db.inbox().length <= MAX_INBOX);
  const started = performance.now();
  for (let index = 0; index < 20; index += 1) db.listJobs().slice(0, 100).map(summarize);
  const perCall = (performance.now() - started) / 20;
  assert.ok(perCall < 25, `list+summarize took ${perCall.toFixed(1)} ms`);
  // finished jobs keep only a clipped prompt, not the whole history/attachments
  const sample = db.listJobs()[0];
  assert.equal(sample.request.messages.length, 1);
  assert.ok(sample.request.messages[0].content.length < 21_000);
});

test("regression: finished jobs drop chat history and attachments (memory + 1.5 s detail polling)", () => {
  const big: ChatRequest = request("cuối", {
    memory: "m".repeat(5_000),
    messages: [
      { role: "user", content: "cũ ".repeat(100_000) },
      { role: "assistant", content: "trả lời" },
      { role: "user", content: `việc mới\n[Đính kèm a.txt]\n${"z".repeat(900_000)}` },
    ],
  });
  const small = compactRequest(big);
  assert.equal(small.messages.length, 1);
  assert.ok(small.messages[0].content.startsWith("việc mới"));
  assert.ok(JSON.stringify(small).length < 25_000);
  assert.equal(small.model, big.model);
});

test("regression: a second server process on the same data dir is detected (no concurrent writers)", () => {
  const dir = tmpDir();
  assert.equal(claimDataDir(dir, process.pid), null);
  assert.equal(claimDataDir(dir, process.pid), null, "re-claim by the owner");
  // another live process (our parent shell) owns it
  const other = process.ppid;
  fs.writeFileSync(path.join(dir, "owner.pid"), `${other}`);
  assert.equal(claimDataDir(dir, process.pid), other);
  // a dead owner is stale and gets replaced
  fs.writeFileSync(path.join(dir, "owner.pid"), "999999999");
  assert.equal(claimDataDir(dir, process.pid), null);
  // pid reused by an unrelated process (start time differs) is stale too
  fs.writeFileSync(path.join(dir, "owner.pid"), `${other} 1`);
  assert.equal(claimDataDir(dir, process.pid), null);
});

// ---------- cron & scheduler ----------

test("regression: cron ranges with more than two bounds (1-2-3) are rejected", () => {
  for (const bad of ["1-2-3 * * * *", "0 1-2-3 * * *", "*/0 * * * *", "0 0 32 * *", "0 0 * * 8", "-1 * * * *", "0 0 * 0 *", "0 0 * * MON-", "*/ * * * *", "0 0 * * * *", ""]) {
    assert.equal(parseCron(bad).ok, false, bad);
  }
  for (const good of ["*/60 * * * *", "0 0 * * 0-7", "0 0 * * sun", "0 0 * jan-mar *", "0 0 1-31/10 * *", "@weekly", "@yearly"]) {
    assert.equal(parseCron(good).ok, true, good);
  }
});

test("deep: cron calendar edge cases in Asia/Saigon (Feb 29, month ends, 23:59→00:00, dom+dow OR)", () => {
  const spec = (expr: string) => {
    const parsed = parseCron(expr);
    assert.ok(parsed.ok, expr);
    return parsed.spec;
  };
  // Feb 29 only in leap years: from Nov 2026 → 29 Feb 2028 00:00 local = 28 Feb 17:00Z
  assert.equal(iso(nextCron(spec("0 0 29 2 *"), at("2026-11-03T00:00:00Z"), SGN)), "2028-02-28T17:00:00.000Z");
  // the 31st skips 30-day months (Nov 2026 has 30 → Dec 31)
  assert.equal(iso(nextCron(spec("0 9 31 * *"), at("2026-11-03T00:00:00Z"), SGN)), "2026-12-31T02:00:00.000Z");
  // 23:59 local on Dec 31 → next is 00:00 local Jan 1 2027 (= 17:00Z Dec 31)
  assert.equal(iso(nextCron(spec("0 0 * * *"), at("2026-12-31T16:59:00Z"), SGN)), "2026-12-31T17:00:00.000Z");
  assert.equal(iso(nextCron(spec("59 23 31 12 *"), at("2026-11-03T00:00:00Z"), SGN)), "2026-12-31T16:59:00.000Z");
  // dom + dow restricted → either: 13th OR Friday (Nov 2026: Fri 6, Fri 13, ...)
  const either = spec("0 8 13 * 5");
  assert.equal(iso(nextCron(either, at("2026-11-03T00:00:00Z"), SGN)), "2026-11-06T01:00:00.000Z");
  assert.equal(iso(nextCron(either, at("2026-11-06T01:00:00Z"), SGN)), "2026-11-13T01:00:00.000Z");
  // dom * with dow restricted → only that weekday
  assert.equal(iso(nextCron(spec("0 8 * * 1"), at("2026-11-03T00:00:00Z"), SGN)), "2026-11-09T01:00:00.000Z");
  // impossible date → never; validation says so
  assert.equal(nextCron(spec("0 0 30 2 *"), at("2026-11-03T00:00:00Z"), SGN), null);
  assert.match(validateSchedule({ kind: "cron", expr: "0 0 31 4,6,9,11 *" }, SGN) ?? "", /không bao giờ/);
});

test("deep: 5-minute minimum holds for every cron shape (wraparound, lists, ranges) and non-integer intervals", () => {
  const now = at("2026-11-03T00:00:00Z");
  for (const tooDense of ["*/7 * * * *", "*/4 * * * *", "0,3 * * * *", "58,1 * * * *", "0-4 * * * *", "2,59 0,23 * * *"]) {
    assert.match(validateSchedule({ kind: "cron", expr: tooDense }, SGN, now) ?? "", /5 phút/, tooDense);
  }
  // 23:59 → 00:02 across local midnight is 3 min apart
  const wrap = parseCron("2,59 0,23 * * *");
  assert.ok(wrap.ok && minGap(wrap.spec, now, SGN) === 3 * MIN);
  for (const fine of ["*/5 * * * *", "*/6 * * * *", "0 7 * * *", "@hourly"]) assert.equal(validateSchedule({ kind: "cron", expr: fine }, SGN, now), null, fine);
  for (const minutes of [4, 4.6, 5.5, 0, -5]) {
    const parsed = parseRoutineInput({ name: "x", prompt: "p", model: "grok-4.7", schedule: { kind: "interval", minutes } }, 20);
    assert.equal(parsed.ok, false, `interval ${minutes}`);
  }
});

function schedulerWith(now: { t: number }, exec: JobExec = async () => undefined, extra: Record<string, unknown> = {}, dir = tmpDir()) {
  const { runner, db } = runnerWith(exec, { now: () => now.t, concurrency: 4 }, dir);
  const scheduler = new RoutineScheduler({ db, runner, now: () => now.t, jobTimeoutMs: 60_000, maxStepsCap: 20, ...extra });
  return { runner, db, scheduler };
}
const input = (over: Record<string, unknown> = {}) => {
  const parsed = parseRoutineInput({ name: "Tin", prompt: "Tóm tắt", schedule: { kind: "interval", minutes: 5 }, model: "grok-4.7", ...over }, 20);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  return parsed.value;
};

test("regression: after the clock jumps backwards a routine re-plans instead of waiting out the old slot", () => {
  const now = { t: at("2026-11-03T03:00:00Z") };
  const { scheduler } = schedulerWith(now);
  const cron = scheduler.create(input({ schedule: { kind: "cron", expr: "*/5 * * * *" } }));
  const interval = scheduler.create(input());
  assert.equal(iso(cron.nextRunAt), "2026-11-03T03:05:00.000Z");
  now.t = at("2026-11-02T03:00:30Z"); // clock set back a day
  scheduler.tick();
  assert.equal(iso(scheduler.get(cron.id)!.nextRunAt), "2026-11-02T03:05:00.000Z");
  assert.ok(scheduler.get(interval.id)!.nextRunAt! <= now.t + 5 * MIN);
  assert.ok(scheduler.get(interval.id)!.anchorAt <= now.t, "interval re-anchored on the corrected clock");
  now.t = at("2026-11-02T03:05:40Z");
  assert.equal(scheduler.tick().length, 2, "both fire on the corrected clock");
  // and the following slots stay on the corrected clock (not back to the old future)
  assert.ok(scheduler.get(interval.id)!.nextRunAt! < at("2026-11-02T03:11:00Z"));
  assert.equal(iso(scheduler.get(cron.id)!.nextRunAt), "2026-11-02T03:10:00.000Z");
});

test("deep: clock jump forward (suspend/resume) → one catch-up, or none with catch-up off", () => {
  for (const catchUpMs of [24 * HOUR, 0]) {
    const now = { t: at("2026-11-03T00:00:00Z") };
    const { scheduler, db } = schedulerWith(now, async () => undefined, { catchUpMs });
    const routine = scheduler.create(input());
    now.t = at("2026-11-03T05:00:00Z");
    const fired = [...scheduler.tick(), ...scheduler.tick(), ...scheduler.tick()];
    assert.equal(fired.length, catchUpMs ? 1 : 0, `catchUp ${catchUpMs}`);
    assert.equal(db.listJobs().length, catchUpMs ? 1 : 0);
    assert.equal(scheduler.get(routine.id)!.history[0].outcome, catchUpMs ? "queued" : "missed");
  }
});

test("regression: a restart between enqueuing a slot's job and saving nextRunAt does not fire that slot twice", async () => {
  const dir = tmpDir();
  const now = { t: at("2026-11-03T00:00:00Z") };
  const first = schedulerWith(now, async () => undefined, {}, dir);
  const routine = first.scheduler.create(input());
  now.t = at("2026-11-03T00:05:05Z");
  // simulate: the job is written, then the process dies before routines.json is updated
  const before = structuredClone(first.db.routines());
  assert.equal(first.scheduler.tick().length, 1);
  await first.runner.idle();
  first.db.saveRoutines(before);
  const second = schedulerWith(now, async () => undefined, {}, dir);
  second.runner.recover();
  assert.equal(second.scheduler.tick().length, 0, "slot already has a job");
  assert.equal(second.db.listJobs().filter((job) => job.routineId === routine.id).length, 1);
  assert.equal(iso(second.scheduler.get(routine.id)!.nextRunAt), "2026-11-03T00:10:00.000Z");
});

test("deep: two scheduler instances in one process (stale one after a module reload) start one job per slot", async () => {
  const now = { t: at("2026-11-03T00:00:00Z") };
  const g = gate();
  const one = schedulerWith(now, g.exec);
  one.scheduler.create(input());
  const two = new RoutineScheduler({ db: one.db, runner: one.runner, now: () => now.t, jobTimeoutMs: 60_000, maxStepsCap: 20 });
  now.t = at("2026-11-03T00:05:05Z");
  const fired = [...one.scheduler.tick(), ...two.tick(), ...one.scheduler.tick(), ...two.tick()];
  assert.equal(fired.length, 1);
  // separate processes on one data dir are kept apart by claimDataDir (tested above)
  for (const release of g.releases.values()) release();
});

test("deep: run-now spam gives one job; edit and delete while it runs are safe", async () => {
  const now = { t: at("2026-11-03T00:00:00Z") };
  const g = gate();
  const { scheduler, db, runner } = schedulerWith(now, g.exec);
  const routine = scheduler.create(input());
  const results = Array.from({ length: 20 }, () => {
    try {
      return scheduler.runNow(routine.id).id;
    } catch (error) {
      assert.ok(error instanceof RoutineRefusal);
      return null;
    }
  });
  assert.equal(results.filter(Boolean).length, 1);
  const jobId = results.find(Boolean)!;
  await waitFor(() => g.releases.size === 1);
  const edited = scheduler.update(routine.id, input({ name: "Đã sửa", prompt: "khác" }));
  assert.equal(edited?.name, "Đã sửa");
  assert.equal(db.getJob(jobId)?.request.messages[0].content, "Tóm tắt", "running job keeps the prompt it started with");
  assert.equal(scheduler.remove(routine.id), true);
  now.t = at("2026-11-03T00:05:05Z");
  assert.equal(scheduler.tick().length, 0);
  for (const release of g.releases.values()) release();
  await runner.idle();
  assert.equal(db.getJob(jobId)?.status, "done");
  assert.throws(() => scheduler.runNow(routine.id), RoutineRefusal);
});

test("deep: per-routine model, effort, preset instructions, memory and tools reach the job request", () => {
  const now = { t: at("2026-11-03T00:00:00Z") };
  const { scheduler, db } = schedulerWith(now, async () => undefined, {}, tmpDir());
  const routine = scheduler.create(
    input({ model: "grok-4.3", effort: "low", presetName: "Dịch", instructions: "Luôn dịch sang tiếng Anh.", memory: "Tên: Tun", tools: { web: true, files: false, image: true } }),
  );
  const job = scheduler.runNow(routine.id);
  const sent = db.getJob(job.id)!.request;
  assert.deepEqual(sent, requestFor(scheduler.get(routine.id)!));
  assert.equal(sent.model, "grok-4.3");
  assert.equal(sent.effort, "low");
  assert.equal(sent.instructions, "Luôn dịch sang tiếng Anh.");
  assert.equal(sent.tools.web, true);
  assert.equal(sent.tools.files, false);
  assert.equal(sent.tools.image, false, "image tool is never on for routines");
});

test("regression: routine input with wrong types is refused, not coerced; long prompts are not cut silently", () => {
  const base = { name: "x", prompt: "p", model: "grok-4.7", schedule: { kind: "interval", minutes: 30 } };
  const bad: Record<string, unknown>[] = [
    { enabled: "false" },
    { catchUp: 0 },
    { tools: { web: "yes" } },
    { tools: ["web"] },
    { maxSteps: "5" },
    { effort: "ultra" },
    { name: 5 },
    { prompt: "p".repeat(8_001) },
    { name: "n".repeat(81) },
    { schedule: { kind: "interval", minutes: "30" } },
    { schedule: { kind: "cron", expr: 5 } },
    { tz: "Mars/Base" },
  ];
  for (const over of bad) assert.equal(parseRoutineInput({ ...base, ...over }, 20).ok, false, JSON.stringify(over).slice(0, 60));
  const clamped = parseRoutineInput({ ...base, maxSteps: 999 }, 20);
  assert.ok(clamped.ok && clamped.value.maxSteps === 20);
  assert.equal(parseRoutineInput([], 20).ok, false);
});

test("deep: kill switch at runtime — jobs off blocks run-now and ticks; routines off keeps jobs working", () => {
  const now = { t: at("2026-11-03T00:00:00Z") };
  let jobsOn = true;
  let routinesOn = true;
  const db = new JobDb(tmpDir());
  const runner = new JobRunner({ db, exec: async () => undefined, now: () => now.t, enabled: () => jobsOn });
  const scheduler = new RoutineScheduler({ db, runner, now: () => now.t, enabled: () => routinesOn, jobTimeoutMs: 1_000, maxStepsCap: 5 });
  const routine = scheduler.create(input());
  jobsOn = false;
  assert.throws(() => scheduler.runNow(routine.id), RoutineRefusal);
  now.t += 6 * MIN;
  assert.equal(scheduler.tick().length, 0);
  jobsOn = true;
  routinesOn = false;
  assert.equal(scheduler.tick().length, 0);
  assert.throws(() => scheduler.runNow(routine.id), RoutineRefusal);
  assert.ok(runner.enqueue({ request: request(), maxSteps: 3, timeoutMs: 1_000 }).id);
});

test("deep: planDue never fires more than once per tick even after a 10-day sleep", () => {
  const routine = { enabled: true, nextRunAt: at("2026-11-03T00:05:00Z"), schedule: { kind: "interval" as const, minutes: 5 }, tz: SGN, catchUp: true, anchorAt: at("2026-11-03T00:00:00Z") };
  const plan = planDue(routine, at("2026-11-13T00:00:30Z"), { graceMs: 120_000, catchUpMs: 30 * 24 * HOUR, busy: false });
  assert.ok(plan.fire?.catchUp);
  assert.ok((plan.nextRunAt ?? 0) > at("2026-11-13T00:00:30Z"));
  assert.equal(nextRun(routine.schedule, SGN, plan.nextRunAt! - 1, routine.anchorAt), plan.nextRunAt);
});

// ---------- HTTP body limits ----------

function streamed(text: string, headers: Record<string, string> = {}) {
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 64 * 1024) controller.enqueue(bytes.slice(offset, offset + 64 * 1024));
      controller.close();
    },
  });
  return new Request("http://x/api", { method: "POST", body, headers, duplex: "half" } as RequestInit);
}

test("regression: body limit holds without Content-Length (chunked) and against a lying header", async () => {
  const huge = JSON.stringify({ ids: ["a".repeat(3_000_000)] });
  const chunked = await readJsonBody(streamed(huge), 100_000);
  assert.deepEqual(chunked.ok ? null : chunked.status, 413);
  const lying = await readJsonBody(streamed(huge, { "content-length": "10" }), 100_000);
  assert.deepEqual(lying.ok ? null : lying.status, 413);
  const declared = await readJsonBody(streamed("{}", { "content-length": "999999999" }), 100_000);
  assert.deepEqual(declared.ok ? null : declared.status, 413);
  const bad = await readJsonBody(streamed("{nope"), 100_000);
  assert.deepEqual(bad.ok ? null : bad.status, 400);
  const fine = await readJsonBody(streamed('{"a":"ă"}'), 100_000);
  assert.ok(fine.ok && (fine.value as { a: string }).a === "ă");
  for (const notObject of ["[1]", "null", "5", '"x"']) {
    const read = await readObjectBody(streamed(notObject), 1_000);
    assert.equal(read.ok, false, notObject);
  }
});

test("regression: a decided or abandoned ask stops showing as 'Chờ duyệt' in the inbox", async () => {
  const answers = new Map<string, boolean>();
  const { runner, db } = runnerWith(asker(answers), { concurrency: 3 });
  const a = runner.enqueue({ title: "a", request: request(), maxSteps: 3, timeoutMs: 60_000 });
  const r = runner.enqueue({ title: "r", request: request(), maxSteps: 3, timeoutMs: 60_000 });
  const c = runner.enqueue({ title: "c", request: request(), maxSteps: 3, timeoutMs: 60_000 });
  await waitFor(() => [a, r, c].every((job) => db.getJob(job.id)?.status === "waiting_approval"));
  const ask = (id: string) => db.inbox().find((item) => item.jobId === id && item.kind === "approval")!;
  assert.ok([a, r, c].every((job) => ask(job.id).status === "waiting_approval" && !ask(job.id).read && ask(job.id).approvalId));
  assert.equal(runner.decide(pendingId(db, a.id), true), true);
  assert.equal(runner.decide(pendingId(db, r.id), false), true);
  assert.equal(runner.cancel(c.id), true);
  await runner.idle();
  assert.match(ask(a.id).snippet, /^Đã duyệt: /);
  assert.match(ask(r.id).snippet, /^Đã từ chối: /);
  for (const job of [a, r, c]) {
    assert.equal(ask(job.id).read, true);
    assert.notEqual(ask(job.id).status, "waiting_approval");
  }
  assert.equal(ask(c.id).status, "cancelled");
  assert.equal(ask(a.id).status, "done");
});

test("regression: an expired ask is settled as 'Hết hạn duyệt' and counts as rejection", async () => {
  const answers = new Map<string, boolean>();
  const { runner, db } = runnerWith(asker(answers), { approvalTtlMs: 30 });
  const job = runner.enqueue({ title: "e", request: request(), maxSteps: 3, timeoutMs: 60_000 });
  await runner.idle();
  assert.equal(answers.get(job.id), false);
  const item = db.inbox().find((entry) => entry.jobId === job.id && entry.kind === "approval")!;
  assert.match(item.snippet, /^Hết hạn duyệt: /);
  assert.equal(item.read, true);
  assert.equal(unreadCount(db), 1, "only the result is new");
});
