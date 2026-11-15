import {
  formatCompactTokenCount,
  type ContextStateData,
} from '@texra-ai/harness/schemas';
import type { RunTone } from '@ui/copy/runStatus';

/**
 * The tone a context-window reading paints with, by the 65/80 thresholds:
 * one rule, so the CLI status bar and the progress view's gauge cannot drift
 * apart on what counts as "getting full".
 */
export function contextGaugeTone(
  percent: number,
): Extract<RunTone, 'success' | 'warning' | 'danger'> {
  if (percent > 80) return 'danger';
  if (percent > 65) return 'warning';
  return 'success';
}

/**
 * Rounds context-window utilization for display, floored at 1%. A run
 * reports a context state only once it has occupied at least one token
 * (`ModelInvoker` gates the `context.state` event on a positive size), so a
 * reading here is never genuinely empty, only ever rounded down to `0.0` by
 * the 1-decimal precision `roundedUtilizationPercent` stores it at. Floor
 * unconditionally rather than treat that rounding artifact as "0% used".
 */
export function roundedContextPercent(percent: number): number {
  return Math.max(1, Math.round(percent));
}

/** How much of the window a run occupies, in every host: `41k / 200k (21%)`.
 *  It reads the run's own `utilizationPercent`, never a used/window
 *  re-derivation, which drifts. */
export function contextUsageText(
  state: Pick<
    ContextStateData,
    'inputTokens' | 'contextWindow' | 'utilizationPercent'
  >,
): string {
  return `${formatCompactTokenCount(state.inputTokens)} / ${formatCompactTokenCount(state.contextWindow)} (${roundedContextPercent(state.utilizationPercent)}%)`;
}
