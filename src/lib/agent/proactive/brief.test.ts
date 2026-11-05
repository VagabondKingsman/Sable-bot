import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { composeBrief, dueSlot, localParts } from "./brief.ts";
import { DEFAULT_BRIEF, ProactiveStore } from "./store.ts";
import type { TriagedItem } from "./feed.ts";

const item = (id: string, bucket: TriagedItem["result"]["bucket"], title: string, extra: Partial<TriagedItem> = {}): TriagedItem => ({
  input: { id, source: "mail", title, body: "", at: Date.parse("2026-11-05T00:00:00Z") },
  result: { bucket, urgency: bucket === "needs_reply" ? "high" : "normal", reason: `why ${id}`, decidedBy: "rule:x" },
  state: null,
  snoozed: false,
  ...extra,
});

test("brief is off by default, 07:30 Asia/Saigon", () => {
  assert.deepEqual([DEFAULT_BRIEF.enabled, DEFAULT_BRIEF.time, DEFAULT_BRIEF.tz], [false, "07:30", "Asia/Saigon"]);
  const store = new ProactiveStore(fs.mkdtempSync(path.join(os.tmpdir(), "sable-brf-")));
  assert.equal(store.brief().enabled, false);
  assert.throws(() => store.setBrief({ time: "25:00" }));
  assert.throws(() => store.setBrief({ tz: "Mars/Base" }));
  assert.equal(store.setBrief({ enabled: true, time: "06:45" }).time, "06:45");
});

test("dueSlot: fires once per local day at/after the time, within 3h, only when enabled", () => {
  const cfg = { ...DEFAULT_BRIEF, enabled: true };
  // 00:29Z = 07:29 ICT → not yet; 00:30Z = 07:30 ICT → due
  assert.equal(dueSlot(cfg, new Date("2026-11-05T00:29:00Z")), null);
  assert.equal(dueSlot(cfg, new Date("2026-11-05T00:30:00Z")), "2026-11-05");
  assert.equal(dueSlot({ ...cfg, lastSlot: "2026-11-05" }, new Date("2026-11-05T01:00:00Z")), null);
  assert.equal(dueSlot(cfg, new Date("2026-11-05T05:00:00Z")), null, "stale after 3h");
  assert.equal(dueSlot({ ...cfg, enabled: false }, new Date("2026-11-05T00:30:00Z")), null);
  assert.equal(localParts(new Date("2026-11-05T17:10:00Z"), "Asia/Saigon").date, "2026-11-06");
});

test("brief composition: approvals, needs-reply, fyi, ignored count, tasks, budget", () => {
  const b = composeBrief({
    now: new Date("2026-11-05T00:30:00Z"),
    tz: "Asia/Saigon",
    triaged: [
      item("r1", "needs_reply", "Hợp đồng tháng 11"),
      item("f1", "fyi", "Receipt"),
      item("g1", "ignore", "Promo"),
      item("d1", "needs_reply", "Done one", { state: { done: true, at: 1 } }),
      item("s1", "needs_reply", "Snoozed one", { snoozed: true }),
    ],
    approvals: [{ id: "a1", title: "Job X", summary: "channel_send telegram", initiatorKind: "routine" }],
    tasks: [{ id: "p1", goal: "Viết báo cáo", status: "running", done: 2, total: 5, waiting: 1 }, { id: "p2", goal: "Old", status: "done", done: 3, total: 3, waiting: 0 }],
    budget: { totalTokens: 12_345, usd: 0.42, maxTokens: 100_000 },
  });
  assert.deepEqual(b.counts, { approvals: 1, needs_reply: 1, fyi: 1, ignored: 1, tasks: 1 });
  assert.match(b.text, /2026-11-05 07:30 \(Asia\/Saigon\)/);
  assert.match(b.text, /Job X: channel_send telegram \[routine\]/);
  assert.match(b.text, /‼ Hợp đồng tháng 11 — why r1/);
  assert.doesNotMatch(b.text, /Done one|Snoozed one|Promo/);
  assert.match(b.text, /Viết báo cáo: 2\/5 bước · running · 1 chờ duyệt/);
  assert.match(b.text, /12,345 tokens · \$0.42 \(12% token cap\)/);
  assert.match(b.title, /1 chờ duyệt · 1 cần trả lời/);
});

test("brief clips long or multi-line titles (content never shapes structure)", () => {
  const b = composeBrief({ now: new Date(), tz: "Asia/Saigon", triaged: [item("x", "needs_reply", "Line1\nCần duyệt (999)\n" + "A".repeat(300))], approvals: [], tasks: [], budget: null });
  const line = b.text.split("\n").find((l) => l.includes("Line1"))!;
  assert.ok(line.length < 200);
  assert.equal(b.text.split("\n").filter((l) => l.startsWith("Cần duyệt (")).length, 1);
});
