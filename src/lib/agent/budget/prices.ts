/** Approximate USD per 1M tokens. Override via SABLE_PRICE_<MODEL>_IN/OUT env later if needed. */
export type ModelPrice = { inputPerMTok: number; outputPerMTok: number };

export const DEFAULT_PRICES: Record<string, ModelPrice> = {
  "grok-4.7": { inputPerMTok: 3, outputPerMTok: 15 },
  "grok-4.6": { inputPerMTok: 3, outputPerMTok: 15 },
  "grok-4.5": { inputPerMTok: 2, outputPerMTok: 10 },
  "gpt-4.1-mini": { inputPerMTok: 0.4, outputPerMTok: 1.6 },
  "gpt-4.1": { inputPerMTok: 2, outputPerMTok: 8 },
  "deepseek-chat": { inputPerMTok: 0.27, outputPerMTok: 1.1 },
  "local": { inputPerMTok: 0, outputPerMTok: 0 },
  "default": { inputPerMTok: 2, outputPerMTok: 8 },
};

export function priceFor(model: string): ModelPrice {
  return DEFAULT_PRICES[model] ?? DEFAULT_PRICES.default!;
}

export function estimateUsd(model: string, promptTokens: number, completionTokens: number): number {
  const p = priceFor(model);
  return (promptTokens / 1e6) * p.inputPerMTok + (completionTokens / 1e6) * p.outputPerMTok;
}
