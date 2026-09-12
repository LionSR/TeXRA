/**
 * Pricing inputs for providers whose cached prompt tokens are a subset of the
 * reported input tokens (OpenAI, OpenRouter, Google). Anthropic bills cache
 * reads/writes additively on top of input tokens and has its own formula in
 * `anthropicUsage.ts`.
 */
export interface StandardPricingConfig {
  inputPrice: number;
  outputPrice: number;
  cacheDiscountFactor: number;
  /**
   * Long-context billing tier (xAI). Once a request's total prompt tokens —
   * cached included — reach the model's threshold, the provider bills every
   * token of that request at the tier's rates, output tokens included, so the
   * complete tuple switches, not just the input rate.
   */
  longContextTier?: LongContextPricingTier;
}

/** Rates that apply to the whole request once the prompt reaches `thresholdTokens`. */
export interface LongContextPricingTier {
  /** Total prompt tokens at which the tier applies (inclusive boundary). */
  thresholdTokens: number;
  inputPrice: number;
  outputPrice: number;
}
