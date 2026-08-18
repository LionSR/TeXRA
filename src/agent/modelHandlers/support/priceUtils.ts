/** Token cost in provider currency. Prices are per 1M tokens. */
export function calculateTokenPrice(
  promptTokens: number,
  completionTokens: number,
  inputPrice: number,
  outputPrice: number,
): number {
  return (promptTokens * inputPrice + completionTokens * outputPrice) / 1e6;
}

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

interface StandardPriceTokens {
  inputTokens: number;
  outputTokens: number;
  /**
   * Cached prompt tokens already counted inside `inputTokens`. Billed above at
   * the full input rate, then rebated down to `inputPrice * cacheDiscountFactor`.
   */
  cachedTokens?: number;
  /**
   * Reasoning tokens billed at the output rate on top of `outputTokens`. Omit
   * for providers (e.g. Google) whose output total already includes them.
   */
  reasoningTokens?: number;
}

/** Inclusive-cache token cost: base price + reasoning surcharge − cache-read rebate. */
export function computeStandardPrice(
  tokens: StandardPriceTokens,
  config: StandardPricingConfig,
): number {
  const reasoningTokens = tokens.reasoningTokens ?? 0;
  const cachedTokens = tokens.cachedTokens ?? 0;

  // `inputTokens` is the total prompt (cached included) — the quantity xAI's
  // long-context threshold compares against. The cache rebate follows the
  // tier: providers scale the cached rate by the same discount factor.
  const tier =
    config.longContextTier &&
    tokens.inputTokens >= config.longContextTier.thresholdTokens
      ? config.longContextTier
      : undefined;
  const inputPrice = tier?.inputPrice ?? config.inputPrice;
  const outputPrice = tier?.outputPrice ?? config.outputPrice;

  return (
    calculateTokenPrice(
      tokens.inputTokens,
      tokens.outputTokens,
      inputPrice,
      outputPrice,
    ) +
    (reasoningTokens * outputPrice) / 1e6 -
    (cachedTokens * inputPrice * (1 - config.cacheDiscountFactor)) / 1e6
  );
}
