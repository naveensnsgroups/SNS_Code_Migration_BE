// Cost is NEVER estimated from a hardcoded pricing table baked into this
// codebase. Provider pricing changes over time and differs per plan/region,
// so a static table shipped in code will always eventually be wrong — and
// worse, silently wrong, with no way for a reader to know it drifted.
//
// Instead, pricing is user-supplied configuration (session.modelPricing,
// set by the user in the frontend Settings UI) — exactly the same principle
// Eclipse Theia's ai-core TokenUsageService follows: it tracks only real
// token counts and has no cost/pricing concept in its core at all. Here we
// keep the cost *feature* (the UI already surfaces it), but the source of
// truth for a rate is always the user, never a guess baked into the app.
//
// If no rate is configured for a model, estimateCost returns null — every
// caller must render that as "cost not available", never substitute $0 or
// any other invented number.

export interface ModelPricingRate {
  /** USD per 1M base input tokens. */
  inputPerM: number;
  /** USD per 1M output tokens. */
  outputPerM: number;
  /** USD per 1M tokens written to a prompt cache. Falls back to inputPerM if omitted. */
  cacheWritePerM?: number;
  /** USD per 1M tokens read from a prompt cache. Falls back to inputPerM if omitted. */
  cacheReadPerM?: number;
}

/** Keyed by the exact model identifier the user configured a rate for. */
export type ModelPricingConfig = Record<string, ModelPricingRate>;

export function estimateCost(
  inputTokens: number,
  outputTokens: number,
  model: string,
  pricing?: ModelPricingConfig,
  cacheWriteTokens = 0,
  cacheReadTokens = 0
): number | null {
  if (!pricing) return null;

  // Exact match only — no substring/prefix guessing. Since rates now come
  // from the user, not the app, there is no "close enough" fallback to make;
  // an unconfigured model is simply unpriced.
  const rate = pricing[model];
  if (!rate) return null;

  const cost =
    (inputTokens       / 1_000_000) * rate.inputPerM +
    (outputTokens      / 1_000_000) * rate.outputPerM +
    (cacheWriteTokens  / 1_000_000) * (rate.cacheWritePerM ?? rate.inputPerM) +
    (cacheReadTokens   / 1_000_000) * (rate.cacheReadPerM  ?? rate.inputPerM);

  return Math.round(cost * 10_000) / 10_000;
}
