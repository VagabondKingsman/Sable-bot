/**
 * Triage eval. Runs the same code the server runs
 * (src/lib/agent/proactive/triage.ts) against items.jsonl.
 *   node --experimental-strip-types evals/triage/run.mjs            # rules + heuristic (offline)
 *   node --experimental-strip-types evals/triage/run.mjs --json     # machine output
 * Exits 1 when a gate fails. Idea adapted from OpenDuet evals/triage (MIT, CopilotKit).
 */
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { triageOne, BUCKETS } from "../../src/lib/agent/proactive/triage.ts";

export const GATES = { accuracy: 0.85, rulesAccuracy: 1, approvalRecall: 1, replyRecall: 0.9, replyPrecision: 0.8 };

export function loadSet() {
  const file = fileURLToPath(new URL("./items.jsonl", import.meta.url));
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

export async function evaluate(items = loadSet(), deps = {}) {
  const rows = [];
  for (const item of items) rows.push({ item, result: await triageOne(item, deps) });
  const right = rows.filter((r) => r.result.bucket === r.item.label);
  const byRule = rows.filter((r) => r.result.decidedBy.startsWith("rule:"));
  const recall = (b) => {
    const want = rows.filter((r) => r.item.label === b);
    return want.length ? want.filter((r) => r.result.bucket === b).length / want.length : 1;
  };
  const precision = (b) => {
    const got = rows.filter((r) => r.result.bucket === b);
    return got.length ? got.filter((r) => r.item.label === b).length / got.length : 1;
  };
  const m = {
    n: rows.length,
    accuracy: right.length / rows.length,
    rules: byRule.length,
    rulesAccuracy: byRule.length ? byRule.filter((r) => r.result.bucket === r.item.label).length / byRule.length : 1,
    approvalRecall: recall("needs_approval"),
    replyRecall: recall("needs_reply"),
    replyPrecision: precision("needs_reply"),
    perBucket: Object.fromEntries(BUCKETS.map((b) => [b, { recall: recall(b), precision: precision(b) }])),
    wrong: rows.filter((r) => r.result.bucket !== r.item.label).map((r) => ({ id: r.item.id, label: r.item.label, got: r.result.bucket, by: r.result.decidedBy })),
    reasonsPresent: rows.every((r) => r.result.reason.length > 0),
  };
  m.pass = Object.entries(GATES).every(([k, v]) => m[k] >= v) && m.reasonsPresent;
  return m;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const m = await evaluate();
  if (process.argv.includes("--json")) console.log(JSON.stringify(m, null, 2));
  else {
    console.log(`triage eval: ${m.n} items, accuracy ${(m.accuracy * 100).toFixed(1)}%, rules decided ${m.rules} (${(m.rulesAccuracy * 100).toFixed(0)}% right)`);
    console.log(`needs_approval recall ${(m.approvalRecall * 100).toFixed(0)}% · needs_reply recall ${(m.replyRecall * 100).toFixed(0)}% precision ${(m.replyPrecision * 100).toFixed(0)}%`);
    for (const w of m.wrong) console.log(`  wrong ${w.id}: want ${w.label}, got ${w.got} (${w.by})`);
    console.log(m.pass ? "PASS" : "FAIL");
  }
  if (!m.pass) process.exitCode = 1;
}
