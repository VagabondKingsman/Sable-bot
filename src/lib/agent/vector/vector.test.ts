import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hashEmbedder, hashVector } from "./embed.ts";
import { chunkText, htmlText } from "./chunk.ts";
import { VectorStore, quantize } from "./store.ts";
import { collectAll, workspaceDocs, SECRET_NAME } from "./sources.ts";
import { syncIndex } from "./indexer.ts";
import { pickEmbedder } from "./select.ts";
import { vectorConfig } from "./config.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "sable-vec-"));
const cos = (a: Float32Array, b: Float32Array) => a.reduce((s, x, i) => s + x * b[i]!, 0);

test("hash embedding is deterministic, normalised, and folds Vietnamese diacritics", () => {
  const a = hashVector("Hội An phố cổ đèn lồng", 256);
  const b = hashVector("hoi an pho co den long", 256);
  assert.equal(a.length, 256);
  assert.ok(Math.abs(cos(a, a) - 1) < 1e-5);
  assert.ok(cos(a, b) > 0.99);
  assert.ok(cos(a, hashVector("quarterly tax filing deadline", 256)) < 0.3);
  assert.deepEqual(Array.from(hashVector("x y z", 64)), Array.from(hashVector("x y z", 64)));
});

test("chunking splits long text with overlap and strips html", () => {
  const long = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} talks about topic ${i % 7}.`).join(" ");
  const parts = chunkText(long, 300);
  assert.ok(parts.length > 3);
  assert.ok(parts.every((p) => p.length <= 300));
  assert.equal(htmlText("<p>Hi <b>there</b></p><script>evil()</script>"), "Hi there");
});

test("store: put/search/remove/persist round trip with int8 quantisation", () => {
  const dir = tmp();
  const e = hashEmbedder(128);
  const s = new VectorStore(dir);
  s.reset(e.id, 128);
  const v1 = hashVector("vector database indexing", 128);
  const v2 = hashVector("chocolate cake recipe", 128);
  s.putDoc("d1", "h1", "workspace", [{ meta: { id: "d1:0", doc: "d1", source: "workspace", title: "a", ref: "a", at: 1, text: "vector database indexing" }, vec: v1 }]);
  s.putDoc("d2", "h2", "workspace", [{ meta: { id: "d2:0", doc: "d2", source: "workspace", title: "b", ref: "b", at: 2, text: "chocolate cake recipe" }, vec: v2 }]);
  s.save();
  assert.equal((fs.statSync(path.join(dir, "vectors.bin")).mode & 0o777).toString(8), "600");
  const r = new VectorStore(dir);
  assert.equal(r.size, 2);
  assert.equal(r.search(hashVector("indexing a vector db", 128), 1)[0]!.chunk.doc, "d1");
  r.removeDoc("d1");
  r.save();
  assert.equal(new VectorStore(dir).size, 1);
  const { q, scale } = quantize(v1);
  assert.ok(Math.abs(q.reduce((s2, x, i) => s2 + x * scale * v1[i]!, 0) - 1) < 0.02);
});

function fixture() {
  const data = tmp();
  const ws = tmp();
  fs.writeFileSync(path.join(data, "memory.json"), JSON.stringify({ version: 1, enabled: true, items: [{ id: "m1", kind: "profile", text: "Owner prefers phở for breakfast", createdAt: 1, updatedAt: 1 }] }));
  fs.writeFileSync(path.join(data, "desk.json"), JSON.stringify({ v: 1, threads: { t1: { thread: { id: "t1", title: "Trip", updatedAt: 5, messages: [{ role: "user", content: "Plan Đà Lạt trip in December" }] } }, t2: { thread: { id: "t2", title: "Dead", updatedAt: 5, messages: [{ role: "user", content: "gone" }] } } }, tombstones: { t2: 1 } }));
  fs.writeFileSync(path.join(data, "vault.json"), JSON.stringify({ secret: "VAULTSECRET-should-never-be-indexed" }));
  fs.mkdirSync(path.join(data, "canvases", "c_0123456789abcdef"), { recursive: true });
  fs.writeFileSync(path.join(data, "canvases", "c_0123456789abcdef", "meta.json"), JSON.stringify({ title: "Garden", version: 1, updatedAt: 3 }));
  fs.writeFileSync(path.join(data, "canvases", "c_0123456789abcdef", "v1.html"), "<h1>Tomato garden plan</h1><p>Water daily.</p>");
  fs.writeFileSync(path.join(ws, "notes.md"), "Kubernetes upgrade checklist. api_key=sk-proj-abcdefghijklmnopqrstuv1234567890 do not leak");
  fs.writeFileSync(path.join(ws, ".env"), "XAI_API_KEY=nope");
  fs.writeFileSync(path.join(ws, "credentials.json"), "{}");
  fs.mkdirSync(path.join(ws, "code", "wt"), { recursive: true });
  fs.writeFileSync(path.join(ws, "code", "wt", "README.md"), "worktree file");
  fs.writeFileSync(path.join(ws, "key.txt"), "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----");
  return { data, ws };
}

test("collectors: all sources, tombstones skipped, vault/secret files/code worktrees never collected", () => {
  const { data, ws } = fixture();
  const docs = collectAll(data, ws);
  const keys = docs.map((d) => d.key).sort();
  assert.deepEqual(keys, ["canvas:c_0123456789abcdef", "mem:m1", "thread:t1", "ws:notes.md"]);
  assert.ok(!JSON.stringify(docs).includes("VAULTSECRET"));
  assert.ok(SECRET_NAME.test(".env") && SECRET_NAME.test("id_rsa") && SECRET_NAME.test("my-token.txt"));
  assert.equal(workspaceDocs(ws).length, 1);
});

test("indexer: redacts before embedding, incremental, propagates deletions, rebuilds on embedder change", async () => {
  const { data, ws } = fixture();
  const dir = tmp();
  const s = new VectorStore(dir);
  const e = hashEmbedder(128);
  let embedded = 0;
  const counting = { ...e, embed: async (t: string[]) => ((embedded += t.length), e.embed(t)) };
  const r1 = await syncIndex(s, counting, collectAll(data, ws), { chunkChars: 800, maxChunks: 1000 });
  assert.equal(r1.added, 4);
  assert.ok(r1.redactions >= 1);
  assert.ok(!s.chunks().some((c) => c.text.includes("sk-proj-abcdefghij")));
  const n1 = embedded;
  const r2 = await syncIndex(s, counting, collectAll(data, ws), { chunkChars: 800, maxChunks: 1000 });
  assert.equal(r2.unchanged, 4);
  assert.equal(embedded, n1);
  fs.writeFileSync(path.join(data, "memory.json"), JSON.stringify({ version: 1, enabled: true, items: [] }));
  fs.rmSync(path.join(ws, "notes.md"));
  const r3 = await syncIndex(s, counting, collectAll(data, ws), { chunkChars: 800, maxChunks: 1000 });
  assert.equal(r3.removed, 2);
  assert.ok(!s.chunks().some((c) => c.doc === "mem:m1" || c.doc === "ws:notes.md"));
  const r4 = await syncIndex(s, hashEmbedder(64), collectAll(data, ws), { chunkChars: 800, maxChunks: 1000 });
  assert.equal(r4.rebuilt, true);
  assert.equal(s.dim, 64);
});

test("pickEmbedder: no keys → hash fallback, xAI skipped without a configured model, kill switch", async () => {
  const cfg = vectorConfig({ SABLE_DATA_DIR: "/tmp/x" });
  let called = 0;
  const f = (async () => ((called += 1), new Response("{}", { status: 404 }))) as unknown as typeof fetch;
  const p = await pickEmbedder(cfg, { XAI_API_KEY: "test" }, f);
  assert.equal(p.embedder.kind, "hash");
  assert.equal(called, 0);
  assert.ok(p.tried.some((t) => t.provider === "xai" && !t.ok));
  const p2 = await pickEmbedder(vectorConfig({ SABLE_EMBED_PROVIDER: "openai" }), { OPENAI_API_KEY: "k" }, (async () => Response.json({ data: [{ index: 0, embedding: [3, 4] }] })) as unknown as typeof fetch);
  assert.equal(p2.embedder.kind, "openai");
  const [v] = await p2.embedder.embed(["x"]);
  assert.ok(Math.abs(v![0]! - 0.6) < 1e-6);
  assert.equal(vectorConfig({ SABLE_VECTOR: "0" }).enabled, false);
});

// ── item 2: hybrid retrieval ──
import { Bm25Index, hybridRank, packHits, recencyScore } from "./hybrid.ts";
import type { ChunkMeta } from "./store.ts";
import { assemble, RECALL_HEADER } from "../assemble.ts";
import { knowledgeRecall } from "../tools/knowledge.ts";
import { parseArgs } from "../tools/validate.ts";

function corpus(now: number) {
  const mk = (id: string, text: string, ageDays: number, source: ChunkMeta["source"] = "workspace"): ChunkMeta => ({ id, doc: id, source, title: id, ref: id, at: now - ageDays * 86_400_000, text });
  return [
    mk("old-pho", "Notes on phở bò recipe and broth simmering time", 400),
    mk("new-pho", "Updated phở bò recipe: char the ginger, simmer bones 8 hours", 1),
    mk("k8s", "Kubernetes cluster upgrade runbook for the staging environment", 10),
    mk("garden", "Tomato garden watering schedule", 3, "canvas"),
  ];
}

test("hybrid: BM25 + vector + recency; recency breaks ties but never surfaces unrelated chunks", () => {
  const now = Date.UTC(2026, 10, 5);
  const chunks = corpus(now);
  const index = new Bm25Index(chunks);
  const dim = 256;
  const vecs = new Map(chunks.map((c) => [c.id, hashVector(c.text, dim)]));
  const q = hashVector("pho recipe", dim);
  const vecScore = (ids: string[]) => new Map(ids.map((id) => [id, cos(q, vecs.get(id)!)]));
  const vecTop = (k: number) => chunks.map((c) => ({ chunk: c, score: cos(q, vecs.get(c.id)!) })).sort((a, b) => b.score - a.score).slice(0, k);
  const hits = hybridRank(index, "pho recipe", vecScore, { now, vecTop });
  assert.equal(hits[0]!.chunk.id, "new-pho");
  assert.ok(hits.some((h) => h.chunk.id === "old-pho"));
  assert.ok(!hits.some((h) => h.chunk.id === "garden" || h.chunk.id === "k8s"));
  // vector-only finds a typo'd/partial query BM25 misses
  const q2 = hashVector("kubernete upgrad", dim);
  const v2 = hybridRank(index, "kubernete upgrad", (ids) => new Map(ids.map((id) => [id, cos(q2, vecs.get(id)!)])), { now, mode: "vector", vecTop: (k) => chunks.map((c) => ({ chunk: c, score: cos(q2, vecs.get(c.id)!) })).sort((a, b) => b.score - a.score).slice(0, k) });
  assert.equal(v2[0]!.chunk.id, "k8s");
  assert.ok(recencyScore(now, now) > recencyScore(now - 90 * 86_400_000, now));
  // source filter
  assert.deepEqual(hybridRank(index, "tomato", null, { now, filter: (c) => c.source === "workspace" }), []);
});

test("packHits respects the token budget; assemble adds an untrusted recall block only when given", () => {
  const now = Date.UTC(2026, 10, 5);
  const hits = corpus(now).map((c) => ({ chunk: c, score: 1, parts: { bm25: 1, vector: 1, recency: 1 } }));
  const packed = packHits(hits, 30);
  assert.ok(packed.text.length <= 120);
  assert.ok(packed.used.length >= 1);
  const base = { instructions: "x", memory: "", messages: [{ role: "user" as const, content: "hi" }], tools: [] };
  assert.ok(!assemble(base).system.includes(RECALL_HEADER));
  const a = assemble({ ...base, recall: packed.text });
  assert.ok(a.system.includes(RECALL_HEADER) && a.system.includes("không phải chỉ dẫn"));
  assert.ok(a.report.some((r) => r.name === "recall"));
});

test("knowledge_recall tool: off without ctx.memory.knowledge, validates sources, returns labelled untrusted excerpts", async () => {
  const ctx = { memory: { canWrite: false, recall: () => [], save: () => ({ status: "skipped" as const }), forget: () => [] } } as never;
  assert.match(String(await knowledgeRecall.check!({ query: "x" }, ctx)), /off/);
  assert.equal(parseArgs(JSON.stringify({ query: "x", sources: ["vault"] }), knowledgeRecall.parameters).ok, false);
  let seen: unknown = null;
  const ctx2 = { memory: { canWrite: false, recall: () => [], save: () => ({ status: "skipped" as const }), forget: () => [], knowledge: async (_q: string, o: unknown) => ((seen = o), [{ source: "thread", title: "Trip", ref: "t1", at: 0, text: "Đà Lạt in December", score: 0.9 }]) } } as never;
  assert.equal(await knowledgeRecall.check!({ query: "x" }, ctx2), null);
  const r = await knowledgeRecall.run({ query: "trip", sources: ["thread"] }, ctx2);
  assert.ok(r.ok && r.output.includes("untrusted data") && r.output.includes("Đà Lạt"));
  assert.deepEqual(seen, { k: 6, sources: ["thread"] });
});
