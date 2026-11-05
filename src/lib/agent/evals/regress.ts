/**
 * W5 nightly regression helpers (pure): parse eval-script output, diff against the previous run,
 * and turn regressions into PROPOSALS for the owner. Never edits code or prompts.
 */
import type { RegressDiff, RegressRun, SuiteResult } from "./store.ts";

export function parseEvalOutput(suite: string, out: string, code: number | null, ms: number): SuiteResult {
  const checks: SuiteResult["checks"] = {};
  for (const line of out.split("\n")) {
    const m = line.match(/^(PASS|FAIL|SKIP)\s+([A-Za-z0-9_.:/@+-]+)/);
    if (m) checks[`${suite}/${m[2]}`] = m[1] === "PASS" ? "pass" : m[1] === "FAIL" ? "fail" : "skip";
  }
  const vals = Object.values(checks);
  return { suite, code, pass: vals.filter((v) => v === "pass").length, fail: vals.filter((v) => v === "fail").length, skip: vals.filter((v) => v === "skip").length, checks, ms, tail: out.split("\n").filter(Boolean).slice(-8).join("\n").slice(-1200) };
}

export function diffRuns(prev: RegressRun | null, suites: SuiteResult[]): RegressDiff {
  const cur: Record<string, string> = Object.assign({}, ...suites.map((s) => s.checks));
  const old: Record<string, string> = prev ? Object.assign({}, ...prev.suites.map((s) => s.checks)) : {};
  const ran = new Set(suites.map((s) => s.suite));
  const keys = new Set([...Object.keys(cur), ...Object.keys(old).filter((k) => ran.has(k.split("/")[0]!))]);
  const d: RegressDiff = { prevId: prev?.id ?? null, newlyFailing: [], fixed: [], added: [], removed: [], suiteErrors: [] };
  for (const k of [...keys].sort()) {
    const a = old[k];
    const b = cur[k];
    if (b === "fail" && a !== "fail") d.newlyFailing.push(k);
    else if (a === "fail" && b === "pass") d.fixed.push(k);
    else if (!a && b) d.added.push(k);
    else if (a && !b) d.removed.push(k);
  }
  for (const s of suites) if (s.code !== 0 && s.fail === 0) d.suiteErrors.push(`${s.suite} (exit ${s.code ?? "timeout"})`);
  if (!prev) d.added = [];
  return d;
}

/** One proposal per regression — a suggestion for the owner, never an action. */
export function proposalsFor(diff: RegressDiff, suites: SuiteResult[]): { title: string; detail: string; proposal: string }[] {
  const out: { title: string; detail: string; proposal: string }[] = [];
  const tailOf = (k: string) => suites.find((s) => s.suite === k.split("/")[0])?.tail ?? "";
  for (const k of diff.newlyFailing) out.push({ title: `Hồi quy: ${k}`, detail: `Kiểm tra ${k} vừa chuyển sang FAIL so với lần chạy trước.\n${tailOf(k)}`, proposal: `Chạy lại \`npm run eval:${k.split("/")[0]}\` để xác nhận; xem commit gần nhất chạm vào phần ${k.split("/")[1]}; nếu đúng là lỗi, mở một task Code (worktree) để sửa và chỉ merge sau khi chủ duyệt.` });
  for (const s of diff.suiteErrors) out.push({ title: `Bộ eval lỗi: ${s}`, detail: `Bộ eval thoát lỗi mà không in FAIL nào (có thể timeout hoặc môi trường).\n${tailOf(s.split(" ")[0]!)}`, proposal: "Kiểm tra server (:8080) đang chạy và log của bộ eval; không tự động sửa gì." });
  return out;
}
