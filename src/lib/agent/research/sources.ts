/** W4 research sources: URL normalisation + dedupe, credibility notes, numbered excerpts. Pure. */
export type SearchHit = { url: string; title?: string; query?: string };
export type Passage = { id: string; text: string };
export type Source = {
  id: string; // S1, S2…
  url: string;
  finalUrl?: string;
  title: string;
  host: string;
  queries: string[];
  status: "pending" | "fetched" | "failed" | "blocked";
  error?: string;
  httpStatus?: number;
  chars?: number;
  /** Full fetched text (kept in the checkpoint so the verifier can match quotes). */
  text?: string;
  passages?: Passage[];
  credibility?: { score: number; notes: string[] };
};

const TRACKING = /^(utm_[a-z]+|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|igshid|si)$/i;

/** Canonical key for dedupe: lowercase host without www., no fragment/tracking params, no trailing slash. */
export function normalizeUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  u.hash = "";
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  u.searchParams.sort();
  let s = `${u.hostname}${u.port ? `:${u.port}` : ""}${u.pathname.replace(/\/+$/, "") || ""}`;
  const q = u.searchParams.toString();
  if (q) s += `?${q}`;
  return s;
}

/** Dedupe hits (by normalized URL, first wins, queries merged); also caps per-host to 2 for diversity. */
export function dedupeHits(hits: SearchHit[], max: number): Source[] {
  const byKey = new Map<string, Source>();
  const perHost = new Map<string, number>();
  for (const h of hits) {
    const key = normalizeUrl(h.url);
    if (!key) continue;
    const existing = byKey.get(key);
    if (existing) {
      if (h.query && !existing.queries.includes(h.query)) existing.queries.push(h.query);
      continue;
    }
    const host = new URL(h.url).hostname.toLowerCase().replace(/^www\./, "");
    if ((perHost.get(host) ?? 0) >= 2) continue;
    if (byKey.size >= max) continue;
    perHost.set(host, (perHost.get(host) ?? 0) + 1);
    byKey.set(key, { id: "", url: h.url, title: (h.title ?? "").slice(0, 200), host, queries: h.query ? [h.query] : [], status: "pending" });
  }
  return [...byKey.values()].map((s, i) => ({ ...s, id: `S${i + 1}` }));
}

/** Content-level dedupe: two fetched sources with near-identical text (mirrors/syndication) → keep the first. */
export function sameContent(a: string, b: string): boolean {
  const sig = (t: string) => new Set(t.toLowerCase().replace(/\s+/g, " ").slice(0, 4000).match(/[a-z0-9à-ỹ]{4,}/gi) ?? []);
  const A = sig(a);
  const B = sig(b);
  if (A.size < 20 || B.size < 20) return false;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter += 1;
  return inter / Math.min(A.size, B.size) > 0.9;
}

/**
 * Heuristic credibility notes (transparent, not a verdict): institutional TLDs, HTTPS,
 * content length, visible date, known UGC/forum hosts. Score 0..5.
 */
export function credibility(src: { url: string; text?: string; httpStatus?: number }): { score: number; notes: string[] } {
  const notes: string[] = [];
  let score = 2;
  let u: URL | null = null;
  try {
    u = new URL(src.url);
  } catch {
    /* noop */
  }
  const host = u?.hostname.toLowerCase() ?? "";
  if (/\.(gov|edu|int|mil)(\.[a-z]{2})?$/.test(host) || /\.(gov|edu)\.[a-z]{2}$/.test(host)) {
    score += 2;
    notes.push("institutional domain (.gov/.edu/.int)");
  } else if (/\.org$/.test(host)) {
    score += 1;
    notes.push(".org domain");
  }
  if (/(^|\.)(wikipedia\.org|arxiv\.org|nature\.com|who\.int|nih\.gov|ietf\.org|w3\.org|developer\.mozilla\.org)$/.test(host)) {
    score += 1;
    notes.push("reference/standards publisher");
  }
  if (/(^|\.)(reddit\.com|quora\.com|medium\.com|pinterest\.|facebook\.com|x\.com|twitter\.com|tiktok\.com|blogspot\.)/.test(host)) {
    score -= 1;
    notes.push("user-generated content: corroborate");
  }
  if (u && u.protocol !== "https:") {
    score -= 1;
    notes.push("not HTTPS");
  }
  const text = src.text ?? "";
  if (text.length < 800) {
    score -= 1;
    notes.push("thin page (<800 chars)");
  }
  if (/\b(19|20)\d{2}-\d{2}-\d{2}\b|\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}, (19|20)\d{2}\b/.test(text)) notes.push("has a visible date");
  else notes.push("no visible date");
  return { score: Math.max(0, Math.min(5, score)), notes };
}

/** Split text into ~500-char passages on sentence boundaries, ids "S3.p2". */
export function passages(sourceId: string, text: string, max = 24, size = 500): Passage[] {
  const clean = text.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const sentences = clean.split(/(?<=[.!?。])\s+|\n\n/);
  const out: Passage[] = [];
  let cur = "";
  for (const s of sentences) {
    if ((cur + " " + s).length > size && cur) {
      out.push({ id: `${sourceId}.p${out.length + 1}`, text: cur.trim() });
      cur = "";
      if (out.length >= max) break;
    }
    cur += (cur ? " " : "") + s;
  }
  if (cur.trim() && out.length < max) out.push({ id: `${sourceId}.p${out.length + 1}`, text: cur.trim() });
  return out;
}
