/**
 * Rounded percentage of the context window consumed by `tokens`. Single
 * source for the rounded log/display value so every surface reports the same
 * precision (1 decimal).
 */
export function roundedUtilizationPercent(
  tokens: number,
  contextWindow: number,
): number {
  return Number(((tokens / contextWindow) * 100).toFixed(1));
}
