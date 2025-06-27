// Utility functions for token usage cost calculations

/**
 * Calculate the price of a request based on token counts.
 *
 * @param promptTokens Number of input tokens
 * @param completionTokens Number of output tokens
 * @param inputPrice Cost per 1M input tokens in provider's currency
 * @param outputPrice Cost per 1M output tokens in provider's currency
 * @returns Total cost for the given token usage
 */
export function calculateTokenPrice(
  promptTokens: number,
  completionTokens: number,
  inputPrice: number,
  outputPrice: number,
): number {
  return (promptTokens * inputPrice + completionTokens * outputPrice) / 1e6;
}
