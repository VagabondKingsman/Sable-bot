/**
 * W4 deep-research defaults. Kill switch SABLE_RESEARCH=0 (API refuses, panel shows off).
 * Run caps: SABLE_RESEARCH_RUN_USD (default $0.50), SABLE_RESEARCH_MAX_STEPS (default 40
 * operations = LLM calls + searches + fetches), SABLE_RESEARCH_MAX_SOURCES (default 8).
 */
export type ResearchConfig = {
  enabled: boolean;
  runUsd: number;
  maxSteps: number;
  maxSources: number;
  maxQueries: number;
  concurrency: number;
  model: string;
  /** Model behind the server-side web_search call (cheaper default; pages are fetched by Sable anyway). */
  searchModel: string;
};

const num = (raw: string | undefined, def: number, min: number, max: number, int = true) => {
  const n = Number(raw);
  if (raw === undefined || raw === "" || !Number.isFinite(n)) return def;
  const v = Math.min(max, Math.max(min, n));
  return int ? Math.floor(v) : v;
};

export function researchConfig(env: Record<string, string | undefined> = process.env): ResearchConfig {
  return {
    enabled: env.SABLE_RESEARCH !== "0",
    runUsd: num(env.SABLE_RESEARCH_RUN_USD, 0.5, 0.01, 5, false),
    maxSteps: num(env.SABLE_RESEARCH_MAX_STEPS, 40, 5, 120),
    maxSources: num(env.SABLE_RESEARCH_MAX_SOURCES, 8, 1, 20),
    maxQueries: num(env.SABLE_RESEARCH_MAX_QUERIES, 3, 1, 8),
    concurrency: num(env.SABLE_RESEARCH_CONCURRENCY, 3, 1, 4),
    model: (env.SABLE_RESEARCH_MODEL || "grok-4.5").trim().slice(0, 60),
    searchModel: (env.SABLE_RESEARCH_SEARCH_MODEL || "grok-4.5").trim().slice(0, 60),
  };
}
