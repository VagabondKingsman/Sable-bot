/**
 * W5 eval (local vector store, hybrid retrieval, self-eval). No external network.
 * - Offline: vector + evals unit suites; a labelled retrieval-quality set (30 docs, 36 queries in
 *   three groups: keyword, fuzzy = no-diacritics/typos/inflection, paraphrase = no shared words)
 *   scored with recall@1, recall@5 and MRR for bm25 / vector / hybrid using the embedder that would
 *   run here (reported honestly — the hash fallback is lexical, so paraphrase recall is expected low);
 *   footprint of a 5 000-chunk synthetic index (bytes on disk, RSS delta, query latency).
 * - Live (running Sable): /api/vector status (which embedder ran), /api/recall validation, /api/evals
 *   view (nightly default off, grader), CSRF 403s, nightly routine disabled, review state validation.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const results = [];
const pass = (n) => (results.push(["PASS", n]), console.log("PASS", n));
const skip = (n, why) => (results.push(["SKIP", n]), console.log("SKIP", n, "-", why));
function fail(n, e) {
  results.push(["FAIL", n]);
  console.error("FAIL", n, e?.message || e);
  process.exitCode = 1;
}
async function run(name, fn) {
  try {
    const r = await fn();
    if (typeof r === "string" && r.startsWith("skip")) return skip(name, r.slice(5) || "skipped");
    pass(name);
  } catch (e) {
    fail(name, e);
  }
}
const BASE = process.env.SABLE_EVAL_URL || "http://127.0.0.1:8080";
const ORIGIN = { origin: BASE.replace("localhost", "127.0.0.1") };

for (const suite of ["src/lib/agent/vector/vector.test.ts", "src/lib/agent/evals/evals.test.ts"]) {
  await run(`unit-suite-${path.basename(suite, ".test.ts")}`, () => {
    const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", "--test", "--test-reporter=tap", suite], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout.slice(-1500));
    assert.ok(/# fail 0/.test(r.stdout));
  });
}

const { VectorStore } = await import("../src/lib/agent/vector/store.ts");
const { syncIndex } = await import("../src/lib/agent/vector/indexer.ts");
const { Bm25Index, hybridRank } = await import("../src/lib/agent/vector/hybrid.ts");
const { pickEmbedder } = await import("../src/lib/agent/vector/select.ts");
const { vectorConfig } = await import("../src/lib/agent/vector/config.ts");
const { hashVector } = await import("../src/lib/agent/vector/embed.ts");

// Eval never sees Sable's env: embedder chosen from an empty env → the same chain the server runs without keys.
const { embedder, tried } = await pickEmbedder(vectorConfig({}), {}, fetch);
console.log(`embedder: ${embedder.id} (${tried.map((t) => `${t.provider}:${t.ok ? "ok" : "no"}`).join(", ")})`);

// ---------- retrieval quality set ----------
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 5);
const D = (key, source, title, text, ageDays = 10) => ({ key, source, title, ref: key, at: NOW - ageDays * DAY, text });
const corpus = [
  D("m-pho", "memory", "Ăn sáng", "Chủ thích ăn phở bò tái vào buổi sáng, không hành."),
  D("m-coffee", "memory", "Cà phê", "Uống cà phê sữa đá ít đường, tránh cà phê sau 3 giờ chiều."),
  D("m-allergy", "memory", "Dị ứng", "Chủ bị dị ứng tôm và hải sản có vỏ."),
  D("m-car", "memory", "Xe", "Xe máy Honda Vision biển số 59, bảo dưỡng định kỳ ở tiệm gần Bến Thành."),
  D("j-run", "journal", "Chạy bộ", "Đã chạy 5 km quanh hồ Con Rùa, nhịp tim trung bình 150.", 2),
  D("j-sleep", "journal", "Giấc ngủ", "Ngủ 6 tiếng, thức dậy lúc 5 giờ, cảm thấy mệt.", 1),
  D("j-budget", "journal", "Chi tiêu", "Chi tiêu tháng 10 vượt ngân sách 2 triệu vì sửa điều hòa.", 20),
  D("t-dalat", "thread", "Đà Lạt", "Lên kế hoạch đi Đà Lạt tháng 12: thuê homestay gần chợ đêm, đi đồi chè Cầu Đất."),
  D("t-tax", "thread", "Thuế TNCN", "Hỏi cách quyết toán thuế thu nhập cá nhân online trên cổng thuế điện tử."),
  D("t-laptop", "thread", "Laptop", "So sánh MacBook Air M4 với ThinkPad X1 Carbon về pin và trọng lượng."),
  D("t-wedding", "thread", "Đám cưới", "Chuẩn bị quà cưới cho đồng nghiệp, phong bì bao nhiêu là hợp lý."),
  D("t-k8s", "thread", "Kubernetes", "Upgrading the Kubernetes cluster from 1.29 to 1.31 requires draining nodes one by one."),
  D("t-sql", "thread", "Postgres", "Slow Postgres query fixed by adding a composite index on (user_id, created_at)."),
  D("c-garden", "canvas", "Vườn", "Kế hoạch trồng cà chua và húng quế trên ban công, tưới nước mỗi sáng."),
  D("c-okr", "canvas", "OKR Q4", "Mục tiêu quý 4: tăng người dùng hoạt động hằng tháng 20%, giảm churn xuống 3%."),
  D("c-recipe", "canvas", "Công thức", "Công thức bánh flan: trứng, sữa tươi, đường caramel, hấp 30 phút."),
  D("c-trip-budget", "canvas", "Ngân sách du lịch", "Bảng ngân sách chuyến Nhật Bản: vé máy bay, JR Pass, khách sạn Kyoto."),
  D("r-wasm", "research", "WebAssembly component model", "The WebAssembly component model defines WIT interfaces so components in different languages can interoperate."),
  D("r-solar", "research", "Điện mặt trời áp mái", "Chi phí lắp điện mặt trời áp mái 5 kWp khoảng 60-70 triệu, hoàn vốn 5-6 năm."),
  D("r-ev", "research", "EV charging", "Electric vehicle home charging with a 7 kW wallbox fills a 60 kWh battery overnight."),
  D("r-rag", "research", "Retrieval augmented generation", "Hybrid retrieval combines BM25 lexical scores with dense embeddings and reranking."),
  D("r-coffee-health", "research", "Caffeine", "Moderate caffeine intake up to 400 mg per day is considered safe for most adults."),
  D("w-onboard", "workspace", "onboarding.md", "Onboarding checklist for new engineers: laptop setup, VPN access, code review rules."),
  D("w-incident", "workspace", "incident-2026-09.md", "Postmortem: the payment service outage was caused by an expired TLS certificate."),
  D("w-meeting", "workspace", "meeting-notes.md", "Họp nhóm thứ hai: chốt lịch phát hành bản 2.0 vào ngày 20 tháng 11."),
  D("w-lease", "workspace", "hop-dong-thue-nha.txt", "Hợp đồng thuê căn hộ quận 3, tiền cọc hai tháng, gia hạn mỗi năm."),
  D("w-backup", "workspace", "backup-policy.md", "Backups run nightly at 02:00 and are kept for 30 days in cold storage."),
  D("w-style", "workspace", "style-guide.md", "Writing style guide: use active voice, short sentences, avoid jargon."),
  D("t-insurance", "thread", "Bảo hiểm", "Tìm hiểu bảo hiểm sức khỏe cho bố mẹ trên 60 tuổi, quyền lợi nội trú.", 40),
  D("j-insurance-old", "journal", "Bảo hiểm (cũ)", "Tìm hiểu bảo hiểm sức khỏe cho bố mẹ trên 60 tuổi, quyền lợi ngoại trú.", 400),
];
const Q = (group, q, want) => ({ group, q, want });
const queries = [
  // keyword: shares distinctive terms with the target
  Q("keyword", "phở bò buổi sáng", "m-pho"),
  Q("keyword", "dị ứng tôm", "m-allergy"),
  Q("keyword", "Kubernetes upgrade drain nodes", "t-k8s"),
  Q("keyword", "Postgres composite index", "t-sql"),
  Q("keyword", "WIT interfaces component model", "r-wasm"),
  Q("keyword", "TLS certificate outage", "w-incident"),
  Q("keyword", "bánh flan caramel", "c-recipe"),
  Q("keyword", "JR Pass Kyoto", "c-trip-budget"),
  Q("keyword", "đồi chè Cầu Đất", "t-dalat"),
  Q("keyword", "quyết toán thuế thu nhập cá nhân", "t-tax"),
  Q("keyword", "BM25 dense embeddings", "r-rag"),
  Q("keyword", "backups cold storage", "w-backup"),
  // fuzzy: no diacritics, typos, inflection
  Q("fuzzy", "pho bo", "m-pho"),
  Q("fuzzy", "di ung hai san", "m-allergy"),
  Q("fuzzy", "kubernete upgrad", "t-k8s"),
  Q("fuzzy", "postgre indexes", "t-sql"),
  Q("fuzzy", "dien mat troi ap mai", "r-solar"),
  Q("fuzzy", "hop dong thue can ho", "w-lease"),
  Q("fuzzy", "ca chua hung que", "c-garden"),
  Q("fuzzy", "certificat expire", "w-incident"),
  Q("fuzzy", "onboardin checklst", "w-onboard"),
  Q("fuzzy", "chay bo ho con rua", "j-run"),
  Q("fuzzy", "macbok thinkpad", "t-laptop"),
  Q("fuzzy", "bao hiem suc khoe bo me", "t-insurance"),
  // paraphrase: meaning only, (almost) no shared words — needs a semantic embedder
  Q("paraphrase", "món ăn yêu thích lúc mới dậy", "m-pho"),
  Q("paraphrase", "what food am I allergic to", "m-allergy"),
  Q("paraphrase", "why did payments go down", "w-incident"),
  Q("paraphrase", "how long do we keep copies of data", "w-backup"),
  Q("paraphrase", "solar panels payback period", "r-solar"),
  Q("paraphrase", "kỳ nghỉ cuối năm ở vùng cao nguyên", "t-dalat"),
  Q("paraphrase", "how much coffee is too much", "r-coffee-health"),
  Q("paraphrase", "charging an electric car at home", "r-ev"),
  Q("paraphrase", "tiền mừng cưới", "t-wedding"),
  Q("paraphrase", "release date for the next major version", "w-meeting"),
  Q("paraphrase", "giảm tỉ lệ khách rời bỏ", "c-okr"),
  Q("paraphrase", "lightweight notebook with long battery", "t-laptop"),
];

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "sable-w5-"));
const store = new VectorStore(tmp());
await syncIndex(store, embedder, corpus, { chunkChars: 800, maxChunks: 1000 });
const bm = new Bm25Index(store.chunks());

async function rank(q, mode) {
  const [qv] = await embedder.embed([q]);
  return hybridRank(bm, q, (ids) => store.scoreIds(qv, ids), { mode, k: 10, now: NOW, vecTop: (k) => store.search(qv, k) }).map((h) => h.chunk.doc);
}
const metrics = {};
for (const mode of ["bm25", "vector", "hybrid"]) {
  for (const group of ["keyword", "fuzzy", "paraphrase", "all"]) {
    const qs = group === "all" ? queries : queries.filter((x) => x.group === group);
    let r1 = 0, r5 = 0, mrr = 0;
    for (const x of qs) {
      const docs = [...new Set(await rank(x.q, mode))];
      const i = docs.indexOf(x.want);
      if (i === 0) r1++;
      if (i >= 0 && i < 5) r5++;
      if (i >= 0) mrr += 1 / (i + 1);
    }
    metrics[`${mode}/${group}`] = { n: qs.length, r1: r1 / qs.length, r5: r5 / qs.length, mrr: mrr / qs.length };
  }
}
const f = (n) => n.toFixed(2);
console.log(`retrieval quality (${queries.length} queries over ${corpus.length} docs, embedder ${embedder.id}); recall@1 / recall@5 / MRR`);
for (const [k, m] of Object.entries(metrics)) console.log(`  ${k.padEnd(18)} n=${String(m.n).padStart(2)}  R@1 ${f(m.r1)}  R@5 ${f(m.r5)}  MRR ${f(m.mrr)}`);
fs.mkdirSync("/tmp/sable-eval-w5", { recursive: true });
fs.writeFileSync("/tmp/sable-eval-w5/metrics.json", JSON.stringify({ embedder: embedder.id, metrics }, null, 2));

await run("retrieval-keyword-hybrid-r5>=0.9", () => assert.ok(metrics["hybrid/keyword"].r5 >= 0.9, JSON.stringify(metrics["hybrid/keyword"])));
await run("retrieval-fuzzy-hybrid-r5>=0.7", () => assert.ok(metrics["hybrid/fuzzy"].r5 >= 0.7, JSON.stringify(metrics["hybrid/fuzzy"])));
await run("retrieval-hybrid-not-worse-than-bm25", () => assert.ok(metrics["hybrid/all"].r5 >= metrics["bm25/all"].r5 && metrics["hybrid/all"].mrr >= metrics["bm25/all"].mrr - 0.02, JSON.stringify([metrics["hybrid/all"], metrics["bm25/all"]])));
await run("retrieval-paraphrase-reported", () => {
  // No gate for the hash embedder: it is lexical. With a semantic embedder this should exceed 0.6.
  if (embedder.kind !== "hash") assert.ok(metrics["hybrid/paraphrase"].r5 >= 0.6, JSON.stringify(metrics["hybrid/paraphrase"]));
});
await run("recency-reorders-equal-matches", async () => {
  const docs = await rank("bảo hiểm", "hybrid");
  assert.ok(docs.indexOf("t-insurance") >= 0 && docs.indexOf("t-insurance") < docs.indexOf("j-insurance-old"), docs.join(","));
});
await run("deletion-propagates", async () => {
  await syncIndex(store, embedder, corpus.filter((d) => d.key !== "w-incident"), { chunkChars: 800, maxChunks: 1000 });
  assert.ok(!store.chunks().some((c) => c.doc === "w-incident"));
  const b2 = new Bm25Index(store.chunks());
  const [qv] = await embedder.embed(["TLS certificate outage"]);
  assert.ok(!hybridRank(b2, "TLS certificate outage", (ids) => store.scoreIds(qv, ids), { now: NOW, vecTop: (k) => store.search(qv, k) }).some((h) => h.chunk.doc === "w-incident"));
});

// ---------- footprint ----------
await run("footprint-5000-chunks", async () => {
  global.gc?.();
  const rss0 = process.memoryUsage().rss;
  const dir = tmp();
  const s = new VectorStore(dir);
  s.reset("hash-v2-512", 512);
  const words = "alpha beta gamma delta sông núi phở cà phê kubernetes vector index mùa thu hà nội sài gòn".split(" ");
  for (let d = 0; d < 1000; d++) {
    const chunks = [];
    for (let c = 0; c < 5; c++) {
      const text = Array.from({ length: 80 }, (_, i) => words[(d * 7 + c * 13 + i * 3) % words.length] + (i % 9 === 0 ? d : "")).join(" ");
      chunks.push({ meta: { id: `d${d}:${c}`, doc: `d${d}`, source: "workspace", title: `d${d}`, ref: `d${d}`, at: NOW, text }, vec: hashVector(text, 512) });
    }
    s.putDoc(`d${d}`, `h${d}`, "workspace", chunks);
  }
  s.save(true);
  const bytes = fs.readdirSync(dir).reduce((a, f2) => a + fs.statSync(path.join(dir, f2)).size, 0);
  const b = new Bm25Index(s.chunks());
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) {
    const qv = hashVector(`kubernetes phở ${i}`, 512);
    hybridRank(b, `kubernetes phở ${i}`, (ids) => s.scoreIds(qv, ids), { vecTop: (k) => s.search(qv, k) });
  }
  const qms = (performance.now() - t0) / 20;
  const rss = (process.memoryUsage().rss - rss0) / 1048576;
  console.log(`  footprint: 5000 chunks → ${(bytes / 1048576).toFixed(1)} MB on disk (vectors ${(fs.statSync(path.join(dir, "vectors.bin")).size / 1048576).toFixed(2)} MB), RSS +${rss.toFixed(0)} MB (store + BM25 + text), hybrid query ${qms.toFixed(1)} ms`);
  assert.ok(qms < 250 && rss < 400);
});

// ---------- live ----------
async function up() {
  try {
    return (await fetch(`${BASE}/api/health`)).ok || true;
  } catch {
    return false;
  }
}
if (!(await up())) {
  skip("live", "Sable not running");
} else {
  await run("live-vector-status", async () => {
    const s = await (await fetch(`${BASE}/api/vector`)).json();
    assert.equal(typeof s.enabled, "boolean");
    if (!s.enabled) return "skip vector off";
    assert.ok(s.embedder && s.tried.length >= 1);
    console.log(`  live embedder: ${s.embedder} (${s.embedderKind}); ${s.stats?.docs} docs / ${s.stats?.chunks} chunks / ${Math.round((s.stats?.bytes || 0) / 1024)} KB`);
  });
  await run("live-recall-validation", async () => {
    assert.equal((await fetch(`${BASE}/api/recall`)).status, 400);
    const r = await (await fetch(`${BASE}/api/recall?q=${encodeURIComponent("kế hoạch")}&mode=bm25&k=3`)).json();
    assert.ok(Array.isArray(r.hits) && r.hits.length <= 3);
    assert.ok(!JSON.stringify(r).includes("vault.json"));
  });
  await run("live-csrf-403", async () => {
    for (const [u, body] of [["/api/vector", { action: "sync" }], ["/api/evals", { action: "settings", nightly: true }], ["/api/evals", { action: "run", suites: ["w0"] }]]) {
      const r = await fetch(`${BASE}${u}`, { method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: JSON.stringify(body) });
      assert.equal(r.status, 403, u);
    }
  });
  await run("live-evals-view-nightly-off", async () => {
    const v = await (await fetch(`${BASE}/api/evals`)).json();
    assert.ok(["rules"].includes(v.grader) || v.grader.startsWith("rules+"));
    assert.equal(v.settings.nightly, false, "nightly must stay off unless the owner turned it on");
    console.log(`  live grader: ${v.grader}; graded runs ${v.summary.runs}, failed ${v.summary.failed}, open reviews ${v.reviews.filter((r) => r.state === "open").length}`);
    const rr = await (await fetch(`${BASE}/api/routines`)).json();
    const list = Array.isArray(rr) ? rr : rr.routines || [];
    const nightly = list.find((x) => x.id === v.routineId);
    assert.ok(nightly && nightly.enabled === false);
  });
  await run("live-evals-validation", async () => {
    const post = (body) => fetch(`${BASE}/api/evals`, { method: "POST", headers: { "content-type": "application/json", ...ORIGIN }, body: JSON.stringify(body) });
    assert.equal((await post({ action: "review", id: "bad", state: "resolved" })).status, 400);
    assert.equal((await post({ action: "review", id: "rev_doesnotexist0", state: "resolved" })).status, 404);
    assert.equal((await post({ action: "nope" })).status, 400);
  });
}

const p = results.filter((r) => r[0] === "PASS").length;
const fl = results.filter((r) => r[0] === "FAIL").length;
const sk = results.filter((r) => r[0] === "SKIP").length;
console.log(fl ? `${p} pass, ${fl} fail, ${sk} skip` : `all w5 eval checks passed (${p} pass, ${sk} skip)`);
