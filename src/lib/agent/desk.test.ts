import test from "node:test";
import assert from "node:assert/strict";
import { applyPush, changesSince, cleanThread, emptyDoc, exportDoc, importFile, parseDoc, DESK_CAPS } from "./desk/sync.ts";

const T = (id: string, content = "hi", extra: Record<string, unknown> = {}) => ({
  id, title: "t-" + id, updatedAt: 1000,
  messages: [{ id: id + "m", role: "user", content, status: "Đang viết", approvals: [{ id: "a", tool: "fs_write", summary: "s", state: "pending" }] }],
  ...extra,
});

test("push stores cleaned thread, newer mtime wins, older ignored", () => {
  const doc = emptyDoc();
  assert.equal(applyPush(doc, { threads: [{ thread: T("a", "v1"), mtime: 10 }] }, 100).changed, 1);
  const stored = doc.threads.a.thread;
  assert.equal(stored.messages[0].status, undefined);
  assert.equal(stored.messages[0].approvals?.[0].state, "expired");
  assert.equal(applyPush(doc, { threads: [{ thread: T("a", "old"), mtime: 5 }] }, 100).changed, 0);
  assert.equal(doc.threads.a.thread.messages[0].content, "v1");
  applyPush(doc, { threads: [{ thread: T("a", "v2"), mtime: 20 }] }, 100);
  assert.equal(doc.threads.a.thread.messages[0].content, "v2");
});

test("tombstone beats older copies, later edit resurrects", () => {
  const doc = emptyDoc();
  applyPush(doc, { threads: [{ thread: T("a"), mtime: 10 }] }, 100);
  applyPush(doc, { deleted: [{ id: "a", at: 20 }] }, 100);
  assert.equal(doc.threads.a, undefined);
  applyPush(doc, { threads: [{ thread: T("a"), mtime: 15 }] }, 100);
  assert.equal(doc.threads.a, undefined, "stale device cannot resurrect");
  applyPush(doc, { threads: [{ thread: T("a"), mtime: 30 }] }, 100);
  assert.ok(doc.threads.a);
});

test("changesSince returns only newer revs; future mtimes clamped", () => {
  const doc = emptyDoc();
  applyPush(doc, { threads: [{ thread: T("a"), mtime: 10 }] }, 100);
  const rev = doc.rev;
  applyPush(doc, { threads: [{ thread: T("b"), mtime: 9e15 }] }, 100);
  assert.ok(doc.threads.b.mtime <= 100 + 60_000);
  const ch = changesSince(doc, rev);
  assert.deepEqual(ch.threads.map((t) => t.thread.id), ["b"]);
  assert.equal(changesSince(doc, 0).threads.length, 2);
  assert.equal(changesSince(doc, 999).full, true);
});

test("invalid input rejected: bad id, huge thread, bad role", () => {
  assert.equal(cleanThread({ id: "../x", messages: [] }), null);
  assert.equal(cleanThread({ id: "ok", messages: "no" }), null);
  const big = T("big");
  (big.messages as unknown[]) = Array.from({ length: 10 }, (_, i) => ({ id: "m" + i, role: "user", content: "x".repeat(300_000) }));
  assert.equal(cleanThread(big), null);
  const t = cleanThread({ id: "ok", messages: [{ id: "1", role: "system", content: "x" }, { id: "2", role: "user", content: "y" }] });
  assert.equal(t?.messages.length, 1);
});

test("caps evict oldest threads", () => {
  const doc = emptyDoc();
  for (let i = 0; i < DESK_CAPS.maxThreads + 5; i += 50)
    applyPush(doc, { threads: Array.from({ length: 50 }, (_, j) => ({ thread: T("t" + (i + j)), mtime: 1 + i + j })) }, 1e6);
  assert.equal(Object.keys(doc.threads).length, DESK_CAPS.maxThreads);
  assert.equal(doc.threads.t0, undefined);
});

test("presets LWW + bindings validated", () => {
  const doc = emptyDoc();
  applyPush(doc, { presets: { state: { presets: [{ id: "p", name: "P", body: "b", updatedAt: 1 }], activePresetId: "p", modelBindings: { m: "p", x: "gone" } }, mtime: 5 } }, 100);
  assert.deepEqual(doc.presets?.state.modelBindings, { m: "p" });
  applyPush(doc, { presets: { state: { presets: [], activePresetId: null, modelBindings: {} }, mtime: 4 } }, 100);
  assert.equal(doc.presets?.state.presets.length, 1);
});

test("parseDoc round trip + export/import merge never deletes", () => {
  const doc = emptyDoc();
  applyPush(doc, { threads: [{ thread: T("a"), mtime: 10 }] }, 100);
  const again = parseDoc(JSON.parse(JSON.stringify(doc)));
  assert.equal(again.threads.a.thread.title, "t-a");
  const file = exportDoc(doc);
  const other = emptyDoc();
  applyPush(other, { threads: [{ thread: T("z"), mtime: 10 }] }, 100);
  const res = importFile(other, JSON.parse(JSON.stringify(file)), 200);
  assert.equal(res?.changed, 1);
  assert.deepEqual(Object.keys(other.threads).sort(), ["a", "z"]);
  assert.equal(importFile(other, { kind: "nope" }), null);
  assert.deepEqual(parseDoc("garbage"), emptyDoc());
});
