import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanSkill, loadedBlock, parseSkill, renderSkill, skillCatalog, skillStore, MAX_SKILL_BODY } from "./skills/skills.ts";
import { loadSkill } from "./tools/skill.ts";
import { assemble } from "./assemble.ts";

const write = (f: string, d: string) => fs.writeFileSync(f, d, { mode: 0o600 });

test("parseSkill reads frontmatter and rejects bad names", () => {
  const s = parseSkill("---\nname: a-b\ndescription: Do X\ntools: [fs_read, web_search]\n---\nBody here");
  assert.deepEqual(s, { name: "a-b", description: "Do X", tools: ["fs_read", "web_search"], body: "Body here" });
  assert.equal(parseSkill("---\nname: ../evil\ndescription: x\n---\nb"), null);
  assert.equal(parseSkill("no frontmatter"), null);
  assert.equal(parseSkill("---\nname: ok\n---\nb"), null, "description required");
  assert.deepEqual(parseSkill(renderSkill(s!)), s);
});

test("cleanSkill validates UI input", () => {
  assert.match(cleanSkill({ name: "Bad Name", description: "d", body: "b" }) as string, /Tên/);
  assert.match(cleanSkill({ name: "ok", description: "d", body: "x".repeat(MAX_SKILL_BODY + 1) }) as string, /tối đa/);
  assert.match(cleanSkill({ name: "ok", description: "d", body: "b", tools: "fs_read, rm -rf" }) as string, /không hợp lệ/);
  assert.deepEqual(cleanSkill({ name: "ok", description: "d", body: "b", tools: "fs_read, fs_read" }), { name: "ok", description: "d", tools: ["fs_read"], body: "b" });
});

test("store CRUD, path safety, symlink ignored", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-"));
  const store = skillStore(dir);
  store.save({ name: "one", description: "first", tools: [], body: "B1" }, write);
  assert.equal(store.list().length, 1);
  assert.equal(store.get("one")?.body, "B1");
  assert.equal(store.get("../one"), null);
  fs.mkdirSync(path.join(dir, "link"));
  fs.writeFileSync(path.join(os.tmpdir(), "outside-skill.md"), "---\nname: link\ndescription: x\n---\nSECRET");
  fs.symlinkSync(path.join(os.tmpdir(), "outside-skill.md"), path.join(dir, "link", "SKILL.md"));
  assert.equal(store.get("link"), null, "symlinked SKILL.md is not followed");
  assert.equal(store.remove("one"), true);
  assert.equal(store.remove("one"), false);
  assert.equal(store.list().length, 0);
});

test("catalog stays within 1500 chars and flags missing tools", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ name: `s${i}`, description: "d".repeat(100), tools: ["web_search"], body: "b" }));
  const cat = skillCatalog(many, new Set(["fs_read"]));
  assert.ok(cat.length <= 1500, String(cat.length));
  assert.match(cat, /cần bật: web_search/);
  assert.match(cat, /\+\d+ skill khác/);
  const a = assemble({ instructions: "I", memory: "", messages: [], tools: [], skills: cat });
  assert.ok(a.report.find((b) => b.name === "skills")!.used <= 1500);
});

test("load_skill returns a loaded block, never grants tools, refuses when off", async () => {
  const s = { name: "r", description: "d", tools: ["web_search", "fs_read"], body: "STEP ONE" };
  const block = loadedBlock(s, new Set(["fs_read"]));
  assert.match(block, /^<loaded skill="r">\nSTEP ONE\n<\/loaded>/);
  assert.match(block, /not enabled this turn \(web_search\)/);
  const ctx = { workspaceDir: "/x", signal: new AbortController().signal, mode: "interactive" as const };
  const off = await loadSkill.run({ name: "r" }, ctx);
  assert.equal(off.ok, false);
  const on = await loadSkill.run({ name: "nope" }, { ...ctx, skills: { load: () => null, names: () => ["r"] } });
  assert.match(on.output, /unknown skill.*Available: r/);
  const ok = await loadSkill.run({ name: "r" }, { ...ctx, skills: { load: () => block, names: () => ["r"] } });
  assert.equal(ok.ok, true);
  const long = loadedBlock({ ...s, body: "x".repeat(20_000) }, new Set());
  assert.ok(long.length < MAX_SKILL_BODY + 400);
});

test("shipped sample skills parse", () => {
  const store = skillStore(path.resolve("skills"));
  assert.deepEqual(store.list().map((s) => s.name), ["code-review", "daily-briefing", "research-deep", "research-summary"]);
});
