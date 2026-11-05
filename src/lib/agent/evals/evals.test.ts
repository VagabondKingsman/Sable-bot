import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { blend, parseJudge, ruleGrade, type RunRecord } from "./grader.ts";
import { EvalStore } from "./store.ts";
import { diffRuns, parseEvalOutput, proposalsFor } from "./regress.ts";
import { unify } from "../proactive/unify.ts";
import { assertNoSend, chipsFor } from "../proactive/chips.ts";

const base: RunRecord = { kind: "chat", ref: "t1", goal: "Tóm tắt bài viết", answer: "Đây là bản tóm tắt đầy đủ của bài viết với các ý chính.", tools: [], seenUrls: [], notices: [], approvals: [] };

test("rule grader: success path, errors, max-steps, refusal, rejected approvals", () => {
  const ok = ruleGrade(base);
  assert.equal(ok.success, 1);
  assert.equal(ok.grounded, 1);
  assert.equal(ok.failed, false);
  assert.equal(ok.grader, "rules");
  assert.equal(ruleGrade({ ...base, error: "boom" }).success, 0);
  assert.equal(ruleGrade({ ...base, stopped: "max_steps" }).success, 0.4);
  assert.equal(ruleGrade({ ...base, answer: "" }).failed, true);
  assert.equal(ruleGrade({ ...base, answer: "Xin lỗi, tôi không thể truy cập trang đó." }).success, 0.5);
  assert.equal(ruleGrade({ ...base, approvals: ["rejected"] }).success, 0.7);
});

test("rule grader groundedness: cited URLs must come from tool results; time-sensitive figures need a search", () => {
  const cited = { ...base, answer: "Theo https://example.com/a và https://evil.test/made-up, giá là 5.", seenUrls: ["https://www.example.com/a/"], tools: ["web_search"] };
  const g = ruleGrade(cited);
  assert.equal(g.grounded, 0.5);
  assert.equal(g.failed, true);
  assert.match(g.reason, /1\/2 cited URLs/);
  assert.equal(ruleGrade({ ...cited, seenUrls: ["https://example.com/a", "https://evil.test/made-up"] }).grounded, 1);
  const cur = ruleGrade({ ...base, goal: "Giá vàng hôm nay bao nhiêu?", answer: "Giá vàng hôm nay là 90 triệu." });
  assert.equal(cur.grounded, 0.5);
  assert.equal(ruleGrade({ ...base, goal: "Giá vàng hôm nay bao nhiêu?", answer: "Giá vàng hôm nay là 90 triệu.", tools: ["web_search"] }).grounded, 1);
});

test("rule grader for research + code runs", () => {
  const r = ruleGrade({ ...base, kind: "research", research: { status: "done", claims: 10, supported: 6, weak: 2, unsupported: 2 } });
  assert.equal(r.success, 1);
  assert.equal(r.grounded, 0.7);
  assert.equal(ruleGrade({ ...base, kind: "research", research: { status: "failed", claims: 0, supported: 0, weak: 0, unsupported: 0 } }).failed, true);
  assert.equal(ruleGrade({ ...base, kind: "code", code: { status: "review", testsOk: true, files: 1 } }).success, 1);
  assert.equal(ruleGrade({ ...base, kind: "code", code: { status: "review", testsOk: false, files: 1 } }).failed, true);
});

test("light-model judge: parse + blend can only lower; hard failures stay 0", () => {
  assert.deepEqual(parseJudge('ok {"success":0.4,"grounded":1,"reason":"partial"}'), { success: 0.4, grounded: 1, reason: "partial" });
  assert.equal(parseJudge("nope"), null);
  const g = blend(ruleGrade(base), { success: 0.4, grounded: 1, reason: "partial" }, "m");
  assert.equal(g.success, 0.7);
  assert.equal(g.grader, "rules+m");
  assert.equal(blend(ruleGrade(base), { success: 1, grounded: 1, reason: "" }, "m").success, 1);
  assert.equal(blend(ruleGrade({ ...base, error: "x" }), { success: 1, grounded: 1, reason: "" }, "m").success, 0);
});

test("eval store: grades, review queue, settings (nightly default off), 0600", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sable-evals-"));
  const s = new EvalStore(dir);
  assert.equal(s.settings().nightly, false);
  assert.ok(!s.settings().suites.includes("w3"));
  s.addGrade({ id: "g1", at: 1, kind: "chat", ref: "t", goal: "g", answer: "a", ...ruleGrade(base) });
  assert.equal(s.grades().length, 1);
  assert.equal((fs.statSync(path.join(dir, "grades.jsonl")).mode & 0o777).toString(8), "600");
  s.addReview({ id: "rev_1", at: 1, type: "failed_run", title: "t", detail: "d", state: "open" });
  assert.equal(s.setReview("rev_1", "dismissed")?.state, "dismissed");
  assert.equal(s.setReview("rev_x", "dismissed"), null);
  assert.equal(s.setSettings({ nightly: true, time: "25:00", suites: ["w0", "bogus"] }).time, "03:00");
  assert.deepEqual(s.settings().suites, ["w0"]);
});

test("regression: parse PASS/FAIL/SKIP, diff vs previous, proposals are text only", () => {
  const a = parseEvalOutput("w0", "PASS one\nPASS two\nSKIP three - x\nall passed", 0, 10);
  assert.deepEqual([a.pass, a.fail, a.skip], [2, 0, 1]);
  const prev = { id: "reg_a", at: 1, manual: false, suites: [a], diff: null, ok: true, ms: 1 };
  const b = parseEvalOutput("w0", "PASS one\nFAIL two boom\nPASS three\nPASS four", 1, 10);
  const d = diffRuns(prev, [b]);
  assert.deepEqual(d.newlyFailing, ["w0/two"]);
  assert.deepEqual(d.added, ["w0/four"]);
  const crash = parseEvalOutput("w1", "Error: cannot connect", 1, 5);
  const d2 = diffRuns(prev, [b, crash]);
  assert.deepEqual(d2.suiteErrors, ["w1 (exit 1)"]);
  const props = proposalsFor(d2, [b, crash]);
  assert.equal(props.length, 2);
  assert.ok(props.every((p) => typeof p.proposal === "string" && /duyệt|không tự động/.test(p.proposal)));
  const fixed = diffRuns({ ...prev, suites: [b] }, [parseEvalOutput("w0", "PASS one\nPASS two\nPASS three\nPASS four", 0, 1)]);
  assert.deepEqual(fixed.fixed, ["w0/two"]);
});

test("review items appear in the Tasks inbox with non-sending chips", () => {
  const tasks = unify({ plans: [], triaged: [], jobs: [], reviews: [{ id: "rev_1", type: "regression_proposal", title: "Hồi quy: w0/two", detail: "x", at: 5 }] });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]!.kind, "review");
  const chips = assertNoSend(chipsFor(tasks[0]!));
  assert.deepEqual(chips.map((c) => c.action), ["review_resolve", "review_dismiss"]);
  assert.ok(chips.every((c) => c.sends === false));
});
