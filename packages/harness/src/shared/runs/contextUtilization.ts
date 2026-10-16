import { roundTo } from '@utils/core';

/**
 * Rounded percentage of the context window consumed by `tokens`. Single
 * source for the rounded log/display value so every surface reports the same
 * precision (1 decimal).
 */
export function roundedUtilizationPercent(
  tokens: number,
  contextWindow: number,
): number {
  return roundTo((tokens / contextWindow) * 100, 1);
}
