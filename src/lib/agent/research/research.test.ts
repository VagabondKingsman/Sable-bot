import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeUrl, dedupeHits, credibility, passages, sameContent } from "./sources.ts";
import { checkCite, parseDraft, verifyDraft, applyJudge, renderReport, norm } from "./cite.ts";
import { newRun, runResearch, type ResearchDeps, type ResearchRun } from "./pipeline.ts";
import { researchFetcher } from "./fetcher.ts";
import { FIXTURE_HITS, startFixtureSite } from "./fixture.ts";
import { researchConfig } from "./config.ts";
import { hitsFromResponse } from "./llm.ts";

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../evals/research/site");

test("research config: kill switch + caps", () => {
  assert.equal(researchConfig({ SABLE_RESEARCH: "0" }).enabled, false);
  const c = researchConfig({});
  assert.equal(c.enabled, true);
  assert.equal(c.runUsd, 0.5);
  assert.equal(researchConfig({ SABLE_RESEARCH_RUN_USD: "99" }).runUsd, 5);
});

test("sources: normalize + dedupe (tracking params, www, fragment, per-host cap)", () => {
  assert.equal(normalizeUrl("https://WWW.Example.com/a/?utm_source=x&b=2#frag"), "example.com/a?b=2");
  assert.equal(normalizeUrl("javascript:alert(1)"), null);
  assert.equal(normalizeUrl("https://u:p@example.com/"), null);
  const s = dedupeHits(FIXTURE_HITS.map((h) => ({ ...h, query: "q" })), 10);
  assert.equal(s.filter((x) => x.host === "archive.valdora.gov").length, 1, "dup URL merged");
  assert.deepEqual(s.map((x) => x.id), s.map((_, i) => `S${i + 1}`));
  const many = dedupeHits(["a", "b", "c"].map((p) => ({ url: `https://one.example/${p}` })), 10);
  assert.equal(many.length, 2, "≤2 per host");
});

test("sources: credibility notes + passages + content dedupe", () => {
  const gov = credibility({ url: "https://transport.valdora.gov/x", text: "x".repeat(900) + " 2025-09-30" });
  assert.ok(gov.score >= 4 && gov.notes.some((n) => /institutional/.test(n)) && gov.notes.includes("has a visible date"));
  const ugc = credibility({ url: "http://reddit.com/r/x", text: "short" });
  assert.ok(ugc.score <= 1 && ugc.notes.some((n) => /user-generated/.test(n)) && ugc.notes.includes("not HTTPS"));
  const ps = passages("S1", "One. ".repeat(300));
  assert.ok(ps.length > 1 && ps[0]!.id === "S1.p1" && ps.every((p) => p.text.length <= 520));
  const t = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor";
  assert.equal(sameContent(t, t + " whiskey"), true);
  assert.equal(sameContent(t, "completely different words entirely here"), false);
});

test("search: hits come only from cited URLs in the Responses result", () => {
  const hits = hitsFromResponse({
    output: [{ type: "message", content: [{ type: "output_text", text: "see https://made-up.example/not-cited", annotations: [{ type: "url_citation", url: "https://a.example/x", title: "A" }] }] }],
    citations: ["https://b.example/y", "javascript:alert(1)"],
  });
  assert.deepEqual(hits.map((h) => h.url), ["https://a.example/x", "https://b.example/y"]);
});

const SRC = [
  { id: "S1", url: "https://a.example/", title: "A", host: "a.example", queries: [], status: "fetched" as const, text: "The Lumen Bridge opened to the public on 4 June 1934. The main span of the bridge is 412 metres long." },
  { id: "S2", url: "https://b.example/", title: "B", host: "b.example", queries: [], status: "failed" as const },
];

test("cite: quote must be verbatim in fetched text; unknown/unfetched sources rejected", () => {
  assert.equal(checkCite({ source: "S1", quote: "opened to the public on 4 June 1934" }, SRC).valid, true);
  assert.equal(checkCite({ source: "S1", quote: "  “opened to the   public on 4 June 1934.”" }, SRC).valid, true, "normalised quotes/space");
  assert.equal(checkCite({ source: "S1", quote: "opened to the public in 1950" }, SRC).reason, "quote not found in fetched text");
  assert.equal(checkCite({ source: "S2", quote: "opened to the public on 4 June 1934" }, SRC).reason, "source was not fetched");
  assert.equal(checkCite({ source: "S9", quote: "opened to the public on 4 June 1934" }, SRC).reason, "unknown source id");
  assert.equal(checkCite({ source: "S1", quote: "1934" }, SRC).reason, "quote too short");
  assert.equal(norm("A\u00a0–  B"), "a - b");
});

test("verifier: supported / weak (numbers) / unsupported (fabricated) + judge only downgrades + render", () => {
  const draft = parseDraft(
    JSON.stringify({
      title: "T",
      summary: "S",
      sections: [
        {
          heading: "H",
          claims: [
            { text: "The Lumen Bridge opened on 4 June 1934.", cites: [{ source: "S1", quote: "opened to the public on 4 June 1934" }] },
            { text: "The main span is 500 metres long.", cites: [{ source: "s1", quote: "The main span of the bridge is 412 metres long" }] },
            { text: "The bridge is made of glass.", cites: [{ source: "S1", quote: "the bridge is made entirely of glass" }] },
            { text: "No cite at all.", cites: [] },
          ],
        },
      ],
    }),
  )!;
  const rep = verifyDraft(draft, SRC);
  assert.deepEqual(rep.sections[0]!.claims.map((c) => c.verdict), ["supported", "weak", "unsupported", "unsupported"]);
  assert.deepEqual(rep.stats, { claims: 4, supported: 1, weak: 1, unsupported: 2, citesValid: 2, citesInvalid: 1 });
  const judged = applyJudge(structuredClone(rep), { C1: "unsupported", C3: "supported" });
  assert.equal(judged.sections[0]!.claims[0]!.verdict, "unsupported", "judge downgrades");
  assert.equal(judged.sections[0]!.claims[2]!.verdict, "unsupported", "judge never upgrades");
  const html = renderReport("Q?", rep, SRC, { runId: "r", at: 0, usd: 0 });
  assert.ok(html.includes("href=\"#src-S1\""));
  assert.ok(!html.includes("made entirely of glass"), "fabricated quote never rendered as evidence");
  assert.match(html, /chưa kiểm chứng/);
  assert.equal(parseDraft("not json"), null);
});

function fakeDeps(over: Partial<ResearchDeps> & { calls?: Record<string, number> }, fetcher: ResearchDeps["fetch"]): ResearchDeps & { calls: Record<string, number>; saved: ResearchRun[]; published: string[] } {
  const calls: Record<string, number> = over.calls ?? { plan: 0, synth: 0, judge: 0, search: 0, fetch: 0 };
  const saved: ResearchRun[] = [];
  const published: string[] = [];
  return {
    calls,
    saved,
    published,
    signal: new AbortController().signal,
    caps: { runUsd: 1, maxSteps: 40, maxSources: 8, maxQueries: 3, concurrency: 3 },
    estimate: { llm: 0.01, search: 0.01 },
    budget: () => ({ ok: true }),
    save: (r) => saved.push(structuredClone(r)),
    publish: async (_t, html) => {
      published.push(html);
      return "canvas-1";
    },
    search: async () => {
      calls.search += 1;
      return { hits: FIXTURE_HITS, usd: 0.01 };
    },
    fetch: async (u, s) => {
      calls.fetch += 1;
      return fetcher(u, s);
    },
    llm: async ({ system }) => {
      if (system.startsWith("You plan")) {
        calls.plan += 1;
        return { text: JSON.stringify({ subquestions: ["When did it open?"], queries: ["lumen bridge history", "lumen bridge maintenance"] }), usd: 0.01 };
      }
      if (system.startsWith("You verify")) {
        calls.judge += 1;
        return { text: JSON.stringify({ C1: "supported", C2: "supported", C3: "supported" }), usd: 0.005 };
      }
      calls.synth += 1;
      return {
        text: JSON.stringify({
          title: "Lumen Bridge",
          summary: "Brief.",
          sections: [
            {
              heading: "History",
              claims: [
                { text: "The Lumen Bridge opened to the public on 4 June 1934.", cites: [{ source: "S1", quote: "the bridge opened to the public on 4 June 1934" }] },
                { text: "Inspectors replaced 38 of the oak deck planks that showed rot.", cites: [{ source: "S3", quote: "Inspectors replaced 38 of the oak deck planks" }] },
                { text: "The bridge is made of glass.", cites: [{ source: "S1", quote: "the bridge is made of glass" }] },
              ],
            },
          ],
        }),
        usd: 0.02,
      };
    },
    ...over,
  };
}

test("pipeline E2E on the local fixture site: SSRF blocks, dedupe, verified cites, canvas", async () => {
  const site = await startFixtureSite(SITE);
  try {
    const deps = fakeDeps({}, researchFetcher(site.deps));
    const run = await runResearch(newRun("a".repeat(16), "What is the history of the Lumen Bridge?", { kind: "user", id: "t" }), deps);
    assert.equal(run.status, "done", run.error);
    const byHost = Object.fromEntries(run.sources.map((s) => [s.host, s]));
    assert.equal(byHost["archive.valdora.gov"]!.status, "fetched");
    assert.match(byHost["mirror.example-news.com"]!.error ?? "", /duplicate content of S1/);
    assert.equal(byHost["redirect.valdora.gov"]!.status, "blocked", "redirect to 127.0.0.1 blocked on hop");
    assert.equal(byHost["169.254.169.254"]!.status, "blocked", "metadata IP blocked");
    assert.ok(!site.requests.some((r) => r.startsWith("127.0.0.1") || r.includes("169.254")));
    assert.equal(deps.calls.search, 2, "one search per planned query, parallel");
    const st = run.report!.stats;
    assert.equal(st.supported, 2);
    assert.equal(st.unsupported, 1, "glass claim (prompt-injection text not quoted verbatim) flagged");
    assert.equal(run.canvasId, "canvas-1");
    assert.ok(deps.published[0]!.includes("transport.valdora.gov/reports/2025"));
    assert.ok(run.steps.every((s) => s.status === "done"));
  } finally {
    await site.close();
  }
});

test("pipeline: resumes from checkpoints (no repeated search/fetch) after an interruption", async () => {
  const site = await startFixtureSite(SITE);
  try {
    const ctl = new AbortController();
    const calls = { plan: 0, synth: 0, judge: 0, search: 0, fetch: 0 };
    const base = fakeDeps({ calls }, researchFetcher(site.deps));
    const crashing = fakeDeps(
      {
        calls,
        signal: ctl.signal,
        llm: async (req) => {
          if (req.system.startsWith("You write")) {
            ctl.abort();
            throw new Error("aborted");
          }
          return base.llm(req);
        },
      },
      researchFetcher(site.deps),
    );
    const run = await runResearch(newRun("b".repeat(16), "Lumen Bridge?", { kind: "user", id: "t" }), crashing);
    assert.equal(run.status, "cancelled");
    assert.deepEqual(run.steps.map((s) => s.status), ["done", "done", "done", "pending", "pending", "pending"]);
    const before = { ...calls };
    const resumed = structuredClone(run);
    const again = await runResearch(resumed, fakeDeps({ calls }, researchFetcher(site.deps)));
    assert.equal(again.status, "done");
    assert.equal(calls.search, before.search, "no new searches");
    assert.equal(calls.fetch, before.fetch, "no new fetches");
    assert.equal(calls.plan, before.plan, "no re-plan");
  } finally {
    await site.close();
  }
});

test("pipeline: per-run budget cap and step cap stop the run (resumable)", async () => {
  const noFetch: ResearchDeps["fetch"] = async () => ({ ok: true, status: 200, text: "x ".repeat(400) });
  const b = await runResearch(newRun("c".repeat(16), "Q", { kind: "user", id: "t" }), fakeDeps({ caps: { runUsd: 0.015, maxSteps: 40, maxSources: 8, maxQueries: 3, concurrency: 1 } }, noFetch));
  assert.equal(b.status, "budget");
  assert.match(b.error!, /run budget reached/);
  const s = await runResearch(newRun("d".repeat(16), "Q", { kind: "user", id: "t" }), fakeDeps({ caps: { runUsd: 5, maxSteps: 3, maxSources: 8, maxQueries: 3, concurrency: 1 } }, noFetch));
  assert.equal(s.status, "step_cap");
  const g = await runResearch(newRun("e".repeat(16), "Q", { kind: "user", id: "t" }), fakeDeps({ budget: () => ({ ok: false, error: "budget exceeded: usd" }) }, noFetch));
  assert.equal(g.status, "budget", "global meter cap also stops");
  assert.equal(g.ops, 0);
});

test("pipeline: parallel searches reserve budget (cannot jointly overshoot the run cap)", async () => {
  const calls = { plan: 0, synth: 0, judge: 0, search: 0, fetch: 0 };
  const r = await runResearch(
    newRun("f".repeat(16), "Q", { kind: "user", id: "t" }),
    fakeDeps({ calls, caps: { runUsd: 0.025, maxSteps: 40, maxSources: 8, maxQueries: 3, concurrency: 3 } }, async () => ({ ok: false })),
  );
  assert.equal(r.status, "budget");
  assert.equal(calls.search, 1, "second parallel search refused by the reservation");
});
