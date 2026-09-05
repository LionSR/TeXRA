import { roundTo } from '@utils/core';

/**
 * Rounded percentage of the context window consumed by `tokens`. Single
 * source for the rounded log/display value so every surface reports the same
 * precision (1 decimal by default; pass `decimals: 0` for coarser displays).
 */
export function roundedUtilizationPercent(
  tokens: number,
  contextWindow: number,
  decimals = 1,
): number {
  return roundTo((tokens / contextWindow) * 100, decimals);
}
