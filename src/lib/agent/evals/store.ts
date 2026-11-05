/**
 * W5 eval store under <dataDir>/evals (0600): grades.jsonl (capped), review.json (failed runs +
 * regression proposals awaiting the owner), regress.json (nightly/manual regression runs),
 * settings.json (nightly toggle, time, suites). Proposals are text only — nothing here edits code.
 */
import fs from "node:fs";
import path from "node:path";
import type { Grade, RunKind } from "./grader.ts";

export type GradeRow = { id: string; at: number; kind: RunKind; ref: string; goal: string; answer: string; ms?: number } & Grade;
export type ReviewState = "open" | "dismissed" | "accepted" | "resolved";
export type ReviewItem = {
  id: string;
  at: number;
  type: "failed_run" | "regression_proposal";
  title: string;
  detail: string;
  state: ReviewState;
  gradeId?: string;
  runKind?: RunKind;
  ref?: string;
  regressId?: string;
  /** Proposal text for the owner (never executed). */
  proposal?: string;
  decidedAt?: number;
};
export type SuiteResult = { suite: string; code: number | null; pass: number; fail: number; skip: number; checks: Record<string, "pass" | "fail" | "skip">; ms: number; tail: string };
export type RegressRun = { id: string; at: number; manual: boolean; suites: SuiteResult[]; diff: RegressDiff | null; ok: boolean; ms: number };
export type RegressDiff = { prevId: string | null; newlyFailing: string[]; fixed: string[]; added: string[]; removed: string[]; suiteErrors: string[] };
export type EvalSettings = { nightly: boolean; time: string; tz: string; suites: string[]; lastSlot: string | null };

export const ALL_SUITES = ["w0", "w1", "w2", "w2a", "w2b", "w2c", "w3", "w4", "w5"] as const;
export const DEFAULT_SETTINGS: EvalSettings = { nightly: false, time: "03:00", tz: "Asia/Saigon", suites: ["w0", "w1", "w2", "w2a", "w2b", "w2c", "w4", "w5"], lastSlot: null };
const MAX_GRADES = 2000;
const MAX_REVIEW = 300;
const MAX_REGRESS = 30;

function writeAtomic(file: string, data: string) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export class EvalStore {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }
  private f(name: string) {
    return path.join(this.dir, name);
  }
  private read<T>(name: string, def: T): T {
    try {
      return JSON.parse(fs.readFileSync(this.f(name), "utf8")) as T;
    } catch {
      return def;
    }
  }
  private write(name: string, v: unknown) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeAtomic(this.f(name), JSON.stringify(v, null, 1));
  }

  addGrade(row: GradeRow) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = this.f("grades.jsonl");
    fs.appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });
    try {
      const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
      if (lines.length > MAX_GRADES * 1.2) writeAtomic(file, `${lines.slice(-MAX_GRADES).join("\n")}\n`);
    } catch {
      /* ignore */
    }
  }
  grades(limit = 200): GradeRow[] {
    try {
      return fs
        .readFileSync(this.f("grades.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .slice(-limit)
        .map((l) => JSON.parse(l) as GradeRow)
        .reverse();
    } catch {
      return [];
    }
  }

  reviews(): ReviewItem[] {
    return this.read<ReviewItem[]>("review.json", []);
  }
  addReview(item: ReviewItem) {
    const list = [item, ...this.reviews()].slice(0, MAX_REVIEW);
    this.write("review.json", list);
    return item;
  }
  setReview(id: string, state: ReviewState): ReviewItem | null {
    let hit: ReviewItem | null = null;
    const list = this.reviews().map((r) => (r.id === id ? (hit = { ...r, state, decidedAt: Date.now() }) : r));
    if (hit) this.write("review.json", list);
    return hit;
  }

  regressRuns(): RegressRun[] {
    return this.read<RegressRun[]>("regress.json", []);
  }
  addRegress(run: RegressRun) {
    this.write("regress.json", [run, ...this.regressRuns()].slice(0, MAX_REGRESS));
  }

  settings(): EvalSettings {
    const s = this.read<Partial<EvalSettings>>("settings.json", {});
    return { ...DEFAULT_SETTINGS, ...s, suites: Array.isArray(s.suites) ? s.suites.filter((x) => (ALL_SUITES as readonly string[]).includes(x)) : DEFAULT_SETTINGS.suites };
  }
  setSettings(patch: Partial<EvalSettings>) {
    const cur = this.settings();
    const next: EvalSettings = {
      nightly: typeof patch.nightly === "boolean" ? patch.nightly : cur.nightly,
      time: typeof patch.time === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(patch.time) ? patch.time : cur.time,
      tz: cur.tz,
      suites: Array.isArray(patch.suites) ? patch.suites.filter((x) => (ALL_SUITES as readonly string[]).includes(x)) : cur.suites,
      lastSlot: patch.lastSlot !== undefined ? patch.lastSlot : cur.lastSlot,
    };
    this.write("settings.json", next);
    return next;
  }
}
