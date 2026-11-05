import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MemoryStore } from "../memory/store.ts";
import { FIELD_JOURNAL_PREFIX, recallLessons, writeLesson } from "./journal.ts";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sable-fj-"));
}

test("field-journal write + recall; secrets redacted", () => {
  const store = new MemoryStore(tmp());
  const saved = writeLesson(store, {
    scenario: "doc-audit",
    lesson: "Always confirm the file is inside the workspace jail before reading.",
    trap: "Reading paths outside jail fails",
    workaround: "Use fs_list first",
    routeId: "R3",
    skill: "daily-briefing",
    eventDate: "2026-11-05",
  });
  assert.equal(saved.ok, true);
  if (!saved.ok) return;
  assert.ok(saved.text.includes(FIELD_JOURNAL_PREFIX));
  // Use a GitHub-pat-shaped fixture (redactor rule) — not a live provider key prefix.
  const fakePat = "ghp_fixtureABCDEFGHIJKLMNOPQRSTUVWX012345";
  const leaked = writeLesson(store, {
    scenario: "docs",
    lesson: `user pasted api key ${fakePat}`,
  });
  // sanitizeMemoryText may skip entirely or redact — never store the raw token.
  if (leaked.ok) assert.ok(!leaked.text.includes(fakePat));
  else assert.equal(leaked.error, "empty_or_secret");
  const hits = recallLessons(store, "doc-audit workspace jail");
  assert.ok(hits.length >= 1);
  assert.ok(hits.some((h) => h.text.includes("workspace jail") || h.text.includes("doc-audit")));
});
