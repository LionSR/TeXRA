import { roundTo } from '@utils/core';

/** Raw percentage of the context window consumed by `tokens`. */
function computeUtilizationPercent(tokens: number, contextWindow: number): number {
  return (tokens / contextWindow) * 100;
}

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
  return roundTo(computeUtilizationPercent(tokens, contextWindow), decimals);
}
