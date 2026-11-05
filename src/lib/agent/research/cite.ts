/**
 * W4 claim-level citations + verifier. Pure.
 *
 * Rule: a citation is kept ONLY when its quote is found verbatim (after whitespace /
 * quote / dash / case normalisation) in the text Sable actually fetched for that source.
 * Claims left with no valid citation are flagged "unsupported" and rendered without
 * any link; claims whose numbers/terms are not backed by their excerpts are "weak".
 * An optional model judge (second pass) can only downgrade, never upgrade.
 */
import type { Source } from "./sources.ts";

export type Cite = { source: string; quote: string };
export type Claim = { text: string; cites: Cite[] };
export type Section = { heading: string; claims: Claim[] };
export type Draft = { title: string; summary: string; sections: Section[] };

export type CheckedCite = Cite & { valid: boolean; reason?: string; url?: string; /** surrounding sentence(s) in the fetched text */ context?: string };

/** Page text that tries to steer the agent is never evidence, even when quoted verbatim. */
export const INJECTION = /ignore (all |any )?(the )?(previous|prior|above) (instructions|prompts?)|disregard (all |the )?(previous |prior )?instructions|cite this (page|source) as|you (must|should) (now )?(say|answer|cite|state|claim)|system prompt|as an ai (model|assistant)/i;

function contextAround(text: string, q: string): string {
  const t = norm(text);
  const i = t.indexOf(q);
  if (i < 0) return "";
  let a = i;
  let b = i + q.length;
  while (a > 0 && i - a < 300 && !/[.!?\n]/.test(t[a - 1]!)) a -= 1;
  while (b < t.length && b - (i + q.length) < 300 && !/[.!?\n]/.test(t[b]!)) b += 1;
  return t.slice(a, Math.min(t.length, b + 1)).trim();
}
export type ClaimVerdict = "supported" | "weak" | "unsupported";
export type CheckedClaim = { text: string; cites: CheckedCite[]; verdict: ClaimVerdict; notes: string[] };
export type CheckedSection = { heading: string; claims: CheckedClaim[] };
export type CheckedReport = {
  title: string;
  summary: string;
  sections: CheckedSection[];
  stats: { claims: number; supported: number; weak: number; unsupported: number; citesValid: number; citesInvalid: number };
};

export const MIN_QUOTE = 12;
export const MAX_QUOTE = 400;

export function norm(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201b\u2032]/g, "'")
    .replace(/[\u201c\u201d\u201f\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const STOP = new Set(
  "about above after again against also among because been before being below between both could does doing down during each from further have having here into itself just more most other over same should some such than that their theirs them then there these they this those through under until very were what when where which while whom will with would your yours".split(" "),
);
const words = (s: string) => (norm(s).match(/[\p{L}\p{N}]{4,}/gu) ?? []).filter((w) => !STOP.has(w));
const numbers = (s: string) => norm(s).match(/\d+(?:[.,]\d+)*%?/g) ?? [];

/** Parse + bound the model's draft JSON (anything malformed is dropped, never invented). */
export function parseDraft(raw: string): Draft | null {
  let j: unknown;
  try {
    j = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch {
    return null;
  }
  const o = j as Record<string, unknown>;
  if (!o || typeof o !== "object" || !Array.isArray(o.sections)) return null;
  const str = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : "");
  const sections: Section[] = [];
  for (const s of (o.sections as unknown[]).slice(0, 12)) {
    const so = s as Record<string, unknown>;
    if (!so || !Array.isArray(so.claims)) continue;
    const claims: Claim[] = [];
    for (const c of (so.claims as unknown[]).slice(0, 20)) {
      const co = c as Record<string, unknown>;
      const text = str(co?.text, 800);
      if (!text) continue;
      const cites: Cite[] = [];
      for (const ci of (Array.isArray(co.cites) ? co.cites : []).slice(0, 4) as unknown[]) {
        const x = ci as Record<string, unknown>;
        const source = str(x?.source, 8).toUpperCase();
        const quote = str(x?.quote, MAX_QUOTE + 50);
        if (/^S\d{1,2}$/.test(source) && quote) cites.push({ source, quote });
      }
      claims.push({ text, cites });
    }
    if (claims.length) sections.push({ heading: str(so.heading, 160) || "Findings", claims });
  }
  return { title: str(o.title, 120) || "Research report", summary: str(o.summary, 1500), sections };
}

export function checkCite(cite: Cite, sources: Source[]): CheckedCite {
  const src = sources.find((s) => s.id === cite.source);
  if (!src) return { ...cite, valid: false, reason: "unknown source id" };
  if (src.status !== "fetched" || !src.text) return { ...cite, valid: false, reason: "source was not fetched" };
  const q = norm(cite.quote).replace(/^["'.…\s]+|["'.…\s]+$/g, "");
  if (q.length < MIN_QUOTE) return { ...cite, valid: false, reason: "quote too short" };
  if (q.length > MAX_QUOTE) return { ...cite, valid: false, reason: "quote too long" };
  if (!norm(src.text).includes(q)) return { ...cite, valid: false, reason: "quote not found in fetched text", url: src.finalUrl ?? src.url };
  const context = contextAround(src.text, q);
  if (INJECTION.test(context)) return { ...cite, valid: false, reason: "excerpt is an embedded instruction (prompt injection), not evidence", url: src.finalUrl ?? src.url, context };
  return { ...cite, valid: true, url: src.finalUrl ?? src.url, context };
}

/** Deterministic verifier pass over the whole draft. */
export function verifyDraft(draft: Draft, sources: Source[]): CheckedReport {
  const stats = { claims: 0, supported: 0, weak: 0, unsupported: 0, citesValid: 0, citesInvalid: 0 };
  const sections = draft.sections.map((sec) => ({
    heading: sec.heading,
    claims: sec.claims.map((c) => {
      stats.claims += 1;
      const cites = c.cites.map((ci) => checkCite(ci, sources));
      const valid = cites.filter((x) => x.valid);
      stats.citesValid += valid.length;
      stats.citesInvalid += cites.length - valid.length;
      const notes: string[] = [];
      for (const bad of cites.filter((x) => !x.valid)) notes.push(`dropped citation ${bad.source}: ${bad.reason}`);
      let verdict: ClaimVerdict = "supported";
      if (!valid.length) {
        verdict = "unsupported";
        notes.push("no fetched excerpt supports this claim");
      } else {
        const quoteText = valid.map((v) => v.quote).join(" ");
        const qn = norm(quoteText);
        const missingNums = numbers(c.text).filter((n) => !qn.includes(n));
        if (missingNums.length) {
          verdict = "weak";
          notes.push(`number(s) not in cited excerpts: ${missingNums.slice(0, 4).join(", ")}`);
        }
        const cw = words(c.text);
        const qw = new Set(words(quoteText));
        const overlap = cw.length ? cw.filter((w) => qw.has(w)).length / cw.length : 1;
        if (overlap < 0.25) {
          verdict = "weak";
          notes.push(`low overlap with excerpts (${Math.round(overlap * 100)}%)`);
        }
      }
      stats[verdict] += 1;
      return { text: c.text, cites, verdict, notes };
    }),
  }));
  return { title: draft.title, summary: draft.summary, sections, stats };
}

/** Second (model) pass: judgments can only downgrade a claim. */
export function applyJudge(report: CheckedReport, judged: Record<string, string>): CheckedReport {
  let k = 0;
  for (const sec of report.sections)
    for (const c of sec.claims) {
      const key = `C${++k}`;
      const j = String(judged[key] ?? "").toLowerCase();
      if (c.verdict === "supported" && (j === "unsupported" || j === "partial")) {
        report.stats.supported -= 1;
        c.verdict = j === "unsupported" ? "unsupported" : "weak";
        report.stats[c.verdict] += 1;
        c.notes.push(`verifier model: ${j}`);
      }
    }
  return report;
}

/** Claims with their valid quotes, keyed C1.., for the model judge. */
export function judgeInput(report: CheckedReport): string {
  const out: string[] = [];
  let k = 0;
  for (const sec of report.sections)
    for (const c of sec.claims) {
      k += 1;
      const q = c.cites.filter((x) => x.valid).map((x) => `"${x.quote}" (in context: "${(x.context ?? x.quote).slice(0, 500)}")`).join(" | ");
      if (q) out.push(`C${k}: CLAIM: ${c.text}\n    EXCERPTS: ${q}`);
    }
  return out.join("\n");
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

/** Canvas HTML: claims with numbered citations → sources list (credibility notes + quoted excerpts). */
export function renderReport(question: string, report: CheckedReport, sources: Source[], meta: { runId: string; at: number; usd: number }): string {
  const used: string[] = [];
  const num = (id: string) => {
    let i = used.indexOf(id);
    if (i < 0) i = used.push(id) - 1;
    return i + 1;
  };
  const body = report.sections
    .map((sec) => {
      const items = sec.claims
        .map((c) => {
          const valid = c.cites.filter((x) => x.valid);
          const refs = valid.map((x) => `<a class="ref" href="#src-${esc(x.source)}" title="${esc(x.quote)}">[${num(x.source)}]</a>`).join("");
          const flag =
            c.verdict === "supported"
              ? ""
              : ` <span class="flag ${c.verdict}" title="${esc(c.notes.join("; "))}">⚠ ${c.verdict === "weak" ? "chưa đủ căn cứ" : "chưa kiểm chứng"}</span>`;
          return `<li class="${c.verdict}">${esc(c.text)} ${refs}${flag}</li>`;
        })
        .join("\n");
      return `<h2>${esc(sec.heading)}</h2>\n<ul>\n${items}\n</ul>`;
    })
    .join("\n");
  const srcList = used
    .map((id) => {
      const s = sources.find((x) => x.id === id)!;
      const quotes = report.sections.flatMap((sec) => sec.claims.flatMap((c) => c.cites.filter((x) => x.valid && x.source === id).map((x) => x.quote)));
      const uniq = [...new Set(quotes)].slice(0, 4);
      return `<li id="src-${esc(id)}"><b>[${num(id)}]</b> ${esc(s.title || s.host)} — <span class="url">${esc(s.finalUrl ?? s.url)}</span><br><small>credibility ${s.credibility?.score ?? "?"}/5: ${esc((s.credibility?.notes ?? []).join("; "))}</small>${uniq.map((q) => `<blockquote>${esc(q)}</blockquote>`).join("")}</li>`;
    })
    .join("\n");
  const other = sources.filter((s) => !used.includes(s.id) && s.status === "fetched");
  const st = report.stats;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(report.title)}</title><style>
body{font:15px/1.55 system-ui,sans-serif;max-width:860px;margin:24px auto;padding:0 16px;color:#1d1d1f}
h1{font-size:24px}h2{font-size:18px;margin-top:26px}.q{color:#555}.ref{font-size:12px;vertical-align:super;text-decoration:none;color:#0a58ca;margin-left:2px}
.flag{font-size:12px;border-radius:4px;padding:1px 6px;margin-left:6px}.flag.weak{background:#fff3cd;color:#664d03}.flag.unsupported{background:#f8d7da;color:#842029}
li{margin:6px 0}li.unsupported{color:#6c757d}blockquote{margin:4px 0 4px 12px;padding-left:8px;border-left:3px solid #ccc;color:#444;font-size:13px}
.url{color:#555;word-break:break-all;font-size:13px}.stats{background:#f4f6f8;border-radius:8px;padding:8px 12px;font-size:13px}
</style></head><body>
<h1>${esc(report.title)}</h1>
<p class="q"><b>Câu hỏi:</b> ${esc(question)}</p>
${report.summary ? `<p>${esc(report.summary)}</p>` : ""}
<p class="stats">Kiểm chứng: ${st.supported}/${st.claims} nhận định có trích dẫn khớp nguyên văn với nguồn đã tải · ${st.weak} chưa đủ căn cứ · ${st.unsupported} chưa kiểm chứng (không có link) · ${st.citesInvalid} trích dẫn bị loại. Run ${esc(meta.runId)} · ${new Date(meta.at).toISOString()} · ≈$${meta.usd.toFixed(3)}</p>
${body}
<h2>Nguồn</h2>
<ol style="list-style:none;padding-left:0">${srcList}</ol>
${other.length ? `<h2>Nguồn đã đọc nhưng không trích dẫn</h2><ul>${other.map((s) => `<li>${esc(s.title || s.host)} — <span class="url">${esc(s.finalUrl ?? s.url)}</span></li>`).join("")}</ul>` : ""}
</body></html>`;
}
