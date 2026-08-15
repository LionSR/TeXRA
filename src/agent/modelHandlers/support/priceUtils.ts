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
}

export interface StandardPriceTokens {
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

  return (
    calculateTokenPrice(
      tokens.inputTokens,
      tokens.outputTokens,
      config.inputPrice,
      config.outputPrice,
    ) +
    (reasoningTokens * config.outputPrice) / 1e6 -
    (cachedTokens * config.inputPrice * (1 - config.cacheDiscountFactor)) / 1e6
  );
}
