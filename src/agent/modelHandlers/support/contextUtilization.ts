/** Percentage of the context window consumed by `tokens`. */
export function computeUtilizationPercent(
  tokens: number,
  contextWindow: number,
): number {
  return (tokens / contextWindow) * 100;
}
