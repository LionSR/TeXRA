/** Token cost in provider currency. Prices are per 1M tokens. */
export function calculateTokenPrice(
  promptTokens: number,
  completionTokens: number,
  inputPrice: number,
  outputPrice: number,
): number {
  return (promptTokens * inputPrice + completionTokens * outputPrice) / 1e6;
}
