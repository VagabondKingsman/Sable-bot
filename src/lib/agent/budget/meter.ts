import fs from "node:fs";
import path from "node:path";
import { estimateUsd } from "./prices.ts";

export type UsageEvent = {
  at: number;
  scope: "chat" | "job" | "plan" | "media" | "desktop" | "research" | "code";
  scopeId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  usd: number;
};

export type BudgetCaps = {
  /** Global soft caps from env. */
  maxTokens?: number;
  maxUsd?: number;
};

export type ScopeTotals = {
  scope: string;
  scopeId: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  usd: number;
  events: number;
};

function budgetEnforceOn(env: NodeJS.ProcessEnv = process.env) {
  // SABLE_BUDGET=0 → meter only, do not fail closed on caps
  return (env.SABLE_BUDGET ?? "1").trim() !== "0";
}

export function readCaps(env: NodeJS.ProcessEnv = process.env): BudgetCaps {
  const maxTokens = Number(env.SABLE_BUDGET_MAX_TOKENS);
  const maxUsd = Number(env.SABLE_BUDGET_MAX_USD);
  return {
    maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : undefined,
    maxUsd: Number.isFinite(maxUsd) && maxUsd > 0 ? maxUsd : undefined,
  };
}

type Disk = { version: 1; events: UsageEvent[] };

export class BudgetMeter {
  private readonly file: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(dataDir: string, env: NodeJS.ProcessEnv = process.env) {
    this.file = path.join(dataDir, "budget-usage.json");
    this.env = env;
  }

  private load(): Disk {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Disk;
      if (raw?.version !== 1 || !Array.isArray(raw.events)) return { version: 1, events: [] };
      return raw;
    } catch {
      return { version: 1, events: [] };
    }
  }

  private save(disk: Disk) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    // Cap history to last 5k events
    if (disk.events.length > 5_000) disk.events = disk.events.slice(-5_000);
    fs.writeFileSync(tmp, JSON.stringify(disk), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  record(input: {
    scope: UsageEvent["scope"];
    scopeId: string;
    model: string;
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    at?: number;
    /** Fixed cost (media generations are priced per item, not per token). */
    usd?: number;
  }): UsageEvent {
    const promptTokens = Math.max(0, Math.floor(input.promptTokens ?? 0));
    const completionTokens = Math.max(0, Math.floor(input.completionTokens ?? 0));
    const totalTokens = Math.max(0, Math.floor(input.totalTokens ?? promptTokens + completionTokens));
    const usd = input.usd != null && Number.isFinite(input.usd) && input.usd >= 0 ? input.usd : estimateUsd(input.model, promptTokens, completionTokens);
    const event: UsageEvent = {
      at: input.at ?? Date.now(),
      scope: input.scope,
      scopeId: input.scopeId.slice(0, 120),
      model: input.model.slice(0, 120),
      promptTokens,
      completionTokens,
      totalTokens,
      usd,
    };
    const disk = this.load();
    disk.events.push(event);
    this.save(disk);
    return event;
  }

  totals(scope?: UsageEvent["scope"], scopeId?: string): ScopeTotals {
    const disk = this.load();
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let usd = 0;
    let events = 0;
    for (const e of disk.events) {
      if (scope && e.scope !== scope) continue;
      if (scopeId && e.scopeId !== scopeId) continue;
      promptTokens += e.promptTokens;
      completionTokens += e.completionTokens;
      totalTokens += e.totalTokens;
      usd += e.usd;
      events += 1;
    }
    return {
      scope: scope ?? "all",
      scopeId: scopeId ?? "*",
      promptTokens,
      completionTokens,
      totalTokens,
      usd,
      events,
    };
  }

  /**
   * Fail closed when over cap and enforce is on.
   * Per-task caps override env globals when provided.
   */
  check(
    extras?: { tokens?: number; usd?: number; addTokens?: number; addUsd?: number },
    envCaps?: BudgetCaps,
  ): { ok: true } | { ok: false; error: string } {
    if (!budgetEnforceOn(this.env)) return { ok: true };
    const caps = envCaps ?? readCaps(this.env);
    const global = this.totals();
    const tokens = (extras?.tokens ?? global.totalTokens) + (extras?.addTokens ?? 0);
    const usd = (extras?.usd ?? global.usd) + (extras?.addUsd ?? 0);
    if (caps.maxTokens != null && tokens > caps.maxTokens) {
      return { ok: false, error: `budget exceeded: tokens ${tokens} > cap ${caps.maxTokens}` };
    }
    if (caps.maxUsd != null && usd > caps.maxUsd) {
      return { ok: false, error: `budget exceeded: usd ${usd.toFixed(4)} > cap ${caps.maxUsd}` };
    }
    return { ok: true };
  }

  /** Check against a plan's own caps (plus optional add). */
  checkPlan(plan: { usedTokens: number; usedUsd: number; budgetTokens?: number; budgetUsd?: number }, addTokens = 0, addUsd = 0) {
    if (!budgetEnforceOn(this.env)) return { ok: true as const };
    if (plan.budgetTokens != null && plan.usedTokens + addTokens > plan.budgetTokens) {
      return { ok: false as const, error: `plan token budget exceeded` };
    }
    if (plan.budgetUsd != null && plan.usedUsd + addUsd > plan.budgetUsd) {
      return { ok: false as const, error: `plan usd budget exceeded` };
    }
    return this.check({ tokens: plan.usedTokens, usd: plan.usedUsd, addTokens, addUsd });
  }

  enforceOn() {
    return budgetEnforceOn(this.env);
  }

  caps() {
    return readCaps(this.env);
  }
}
