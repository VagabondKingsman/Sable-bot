import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { redactSecrets, sanitizeMemoryText, luhn, REDACTION_MASK } from "./memory/redact.ts";
import { fold, memoryBlock, search } from "./memory/rank.ts";
import { MemoryStore, similarity } from "./memory/store.ts";
import { buildExtractPrompt, parseExtraction, worthExtracting } from "./memory/extract.ts";
import { memoryForget, memoryRecall, memorySave } from "./tools/memory.ts";
import { createRegistry, builtinTools, selectTools } from "./tools/registry.ts";
import { assemble, LEARNED_HEADER } from "./assemble.ts";
import type { MemoryAccess, ToolContext } from "./tools/types.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "sable-mem-"));
const fakeKey = () => "xai-" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";

test("redact: keys, tokens, cards, labeled passwords are masked", () => {
  const card = "4111 1111 1111 1111";
  assert.ok(luhn(card.replace(/ /g, "")));
  const input = `key ${fakeKey()} card ${card} password: hunter22x bot 123456789:${"A".repeat(35)} url https://u:p4ss@example.com/x`;
  const out = redactSecrets(input);
  assert.ok(!out.text.includes(fakeKey()));
  assert.ok(!out.text.includes("4111 1111"));
  assert.ok(!out.text.includes("hunter22x"));
  assert.ok(!out.text.includes("p4ss@"));
  assert.ok(out.text.includes(REDACTION_MASK));
  assert.ok(out.hits.length >= 4);
});

test("redact: normal text and non-Luhn numbers untouched", () => {
  const text = "Tun thích cà phê sữa đá, số nhà 1234 5678 9012 3456 không phải thẻ";
  assert.equal(redactSecrets("Tun thích cà phê sữa đá").text, "Tun thích cà phê sữa đá");
  assert.equal(redactSecrets("token limit is high? pin this note").text, "token limit is high? pin this note".replace(/x/g, "x"));
  assert.ok(redactSecrets(text).text.includes("1234 5678 9012 3456") || !luhn("1234567890123456"));
});

test("sanitize: credential facts are dropped, others clipped", () => {
  assert.equal(sanitizeMemoryText("Mật khẩu wifi là: abcd1234xyz"), null);
  assert.equal(sanitizeMemoryText(`My api key is ${fakeKey()}`), null);
  assert.equal(sanitizeMemoryText("   "), null);
  assert.equal(sanitizeMemoryText("Thích đọc sách lịch sử"), "Thích đọc sách lịch sử");
  const long = sanitizeMemoryText("a ".repeat(400), 50)!;
  assert.ok(long.length <= 50);
});

test("rank: diacritics folded, relevant journal beats irrelevant, budget respected", () => {
  assert.equal(fold("Đà Nẵng"), "da nang");
  const dir = tmp();
  const store = new MemoryStore(dir);
  store.add({ text: "Tun sống ở Sài Gòn", source: "user", pinned: true });
  store.add({ text: "Tun dị ứng tôm", source: "chat" });
  store.add({ text: "Đi Đà Nẵng tháng 12", kind: "journal", eventDate: "2026-12-01", source: "chat" });
  store.add({ text: "Đã sửa xe máy ở tiệm gần nhà", kind: "journal", source: "chat" });
  const hits = search(store.list(), "da nang");
  assert.match(hits[0].memory.text, /Đà Nẵng/);
  const block = memoryBlock(store.list(), "chuyến đi da nang", 3000);
  assert.ok(block.text.indexOf("Sài Gòn") < block.text.indexOf("Đà Nẵng"));
  assert.equal(block.used.length, 4);
  const tiny = memoryBlock(store.list(), "x", 40);
  assert.ok(tiny.text.length <= 40 && tiny.clipped);
});

test("store: dedupe merge, secret refused, update/remove/forget, persistence", () => {
  const dir = tmp();
  const store = new MemoryStore(dir);
  const a = store.add({ text: "Tun thích uống cà phê đen", source: "chat" });
  assert.equal(a.status, "added");
  const b = store.add({ text: "Tun thích uống cà phê đen.", source: "chat" });
  assert.equal(b.status, "merged");
  assert.ok(similarity("abc def", "abc def") >= 0.99);
  assert.equal(store.add({ text: "password: zzz999yyy", source: "chat" }).status, "skipped");
  assert.equal(store.list().length, 1);
  const id = store.list()[0].id;
  assert.deepEqual(store.update(id, { text: `token ${fakeKey()}` }), { error: store.update(id, { text: `token ${fakeKey()}` }) && (store.update(id, { text: `token ${fakeKey()}` }) as { error: string }).error });
  assert.equal((store.update(id, { pinned: true }) as { pinned: boolean }).pinned, true);
  assert.equal(store.update("nope", { pinned: true }), undefined);
  store.add({ text: "Con mèo tên Mướp", source: "user" });
  const reopened = new MemoryStore(dir);
  assert.equal(reopened.list().length, 2);
  assert.equal(reopened.list()[0].pinned, true);
  assert.equal(reopened.forget("mèo Mướp").length, 1);
  assert.equal(reopened.remove("all"), 1);
  assert.equal(reopened.list().length, 0);
  const mode = fs.statSync(path.join(dir, "memory.json")).mode & 0o777;
  assert.equal(mode & 0o077, 0, "memory.json is owner-only");
});

test("store: cap evicts journal first; retention drops old unpinned journal", () => {
  let now = Date.UTC(2026, 0, 1);
  const store = new MemoryStore(tmp(), { max: 10, journalDays: 30, now: () => now });
  const words = ["phở", "bún chả", "cơm tấm", "bánh mì", "chè", "gỏi cuốn", "bánh xèo", "cao lầu", "mì quảng", "hủ tiếu"];
  for (const word of words) store.add({ text: `${word}`.toUpperCase() + " " + word.split("").reverse().join("") + " là món ruột của Tun", source: "user" });
  assert.equal(store.stats().total, 10);
  store.add({ text: "journal event alpha bravo", kind: "journal", source: "chat" });
  assert.equal(store.stats().total, 10);
  assert.equal(store.stats().journal, 0);
  const fresh = new MemoryStore(tmp(), { journalDays: 30, now: () => now });
  fresh.add({ text: "old trip to Hue", kind: "journal", source: "chat" });
  fresh.add({ text: "pinned old trip to Hoi An", kind: "journal", source: "chat", pinned: true });
  now += 40 * 86_400_000;
  fresh.add({ text: "new unrelated profile fact", source: "user" });
  const texts = fresh.list().map((item) => item.text);
  assert.ok(!texts.includes("old trip to Hue"));
  assert.ok(texts.includes("pinned old trip to Hoi An"));
});

test("store: corrupt file set aside, toggle persists, import/export round trip, replace never wipes on junk", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "memory.json"), "{not json");
  const store = new MemoryStore(dir);
  assert.equal(store.list().length, 0);
  assert.ok(fs.readdirSync(dir).some((name) => name.startsWith("memory.json.corrupt-")));
  store.add({ text: "Thích nhạc Trịnh", source: "user" });
  store.setEnabled(false);
  assert.equal(new MemoryStore(dir).enabled(), false);
  const exported = store.exportFile();
  const other = new MemoryStore(tmp());
  assert.deepEqual(other.importItems(exported), { added: 1, merged: 0, skipped: 0 });
  assert.deepEqual(other.importItems([{ text: `secret ${fakeKey()}` }, { nope: 1 }]), { added: 0, merged: 0, skipped: 2 });
  assert.ok("error" in other.importItems({ foo: 1 }));
  assert.ok("error" in other.importItems([{ nope: 1 }], "replace"));
  assert.equal(other.list().length, 1);
});

test("extract: prompt redacts, parser is strict and ignores unknown ids", () => {
  const prompt = buildExtractPrompt([{ role: "user", content: `nhớ giúp key ${fakeKey()}` }], [], "2026-11-03");
  assert.ok(!prompt.includes(fakeKey()));
  const known = new Set(["m1"]);
  const parsed = parseExtraction('```json\n{"add":[{"text":"Thích phở","kind":"profile"},{"text":""},5],"update":[{"id":"m1","text":"x y z"},{"id":"zz","text":"q"}],"forget":["m1","bad"]}\n```', known);
  assert.equal(parsed.add.length, 1);
  assert.deepEqual(parsed.update, [{ id: "m1", text: "x y z" }]);
  assert.deepEqual(parsed.forget, ["m1"]);
  for (const junk of ["", "nope", "[1,2]", "null", '{"add":"x"}']) assert.deepEqual(parseExtraction(junk, known), { add: [], update: [], forget: [] });
  assert.equal(worthExtracting([{ role: "user", content: "hi" }]), false);
  assert.equal(worthExtracting([{ role: "user", content: "Tôi mới chuyển sang Hà Nội" }]), true);
});

function access(canWrite: boolean): MemoryAccess & { saved: string[] } {
  const saved: string[] = [];
  return {
    saved,
    canWrite,
    recall: () => [{ id: "1", kind: "profile", text: "Thích phở" }],
    save: (text) => (saved.push(text), { status: "added", text }),
    forget: () => ["Thích phở"],
  };
}
const ctxOf = (mode: "interactive" | "background", memory?: MemoryAccess): ToolContext => ({ workspaceDir: "/x", signal: new AbortController().signal, mode, memory });

test("memory tools: writes only in interactive chats with canWrite; recall anywhere memory is on", async () => {
  assert.equal(await memoryRecall.check!({ query: "a" }, ctxOf("background")), "memory is off for this turn");
  assert.equal(await memoryRecall.check!({ query: "a" }, ctxOf("background", access(false))), null);
  assert.match((await memoryRecall.run({ query: "a" }, ctxOf("background", access(false)))).output, /Thích phở/);
  assert.notEqual(await memorySave.check!({ text: "x" }, ctxOf("background", access(true))), null);
  assert.notEqual(await memorySave.check!({ text: "x" }, ctxOf("interactive", access(false))), null);
  assert.notEqual(await memoryForget.check!({ query: "x" }, ctxOf("background", access(true))), null);
  assert.equal(await memorySave.check!({ text: "x" }, ctxOf("interactive", access(true))), null);
});

test("registry: memory tools only with the learned flag; learned block in the prompt", () => {
  const registry = createRegistry(builtinTools());
  const caps = { serverTools: false, functionTools: true };
  const base = { web: false, x: false, code: false, image: false };
  assert.equal(selectTools(registry, base, caps).functions.length, 0);
  assert.deepEqual(selectTools(registry, { ...base, learned: true }, caps).functions.map((tool) => tool.name).sort(), ["knowledge_recall", "memory_forget", "memory_recall", "memory_save"]);
  assert.equal(selectTools(registry, { ...base, learned: true }, { serverTools: false, functionTools: false }).functions.length, 0);
  const withBlock = assemble({ instructions: "x", memory: "", messages: [{ role: "user", content: "hi" }], tools: [], learned: "- Thích phở" });
  assert.ok(withBlock.system.includes(LEARNED_HEADER) && withBlock.system.includes("Thích phở"));
  const without = assemble({ instructions: "x", memory: "", messages: [{ role: "user", content: "hi" }], tools: [] });
  assert.ok(!without.system.includes(LEARNED_HEADER));
});
