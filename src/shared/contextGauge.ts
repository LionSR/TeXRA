export type ContextGaugeBand = 'ok' | 'warning' | 'error';

/**
 * The 65/80 thresholds the CLI status bar and the progress view's context
 * gauge both color by. One rule, so the two hosts can't drift apart on what
 * counts as "getting full".
 */
export function contextGaugeBand(percent: number): ContextGaugeBand {
  if (percent > 80) return 'error';
  if (percent > 65) return 'warning';
  return 'ok';
}

/**
 * Rounds context-window utilization for display, floored at 1%. Both callers
 * only report a context state once the run has occupied at least one input
 * token (`ModelInvoker` gates `logger.contextState` on `inputTokens > 0`), so
 * a reading here is never genuinely empty — only ever rounded down to `0.0`
 * by the 1-decimal precision `roundedUtilizationPercent` stores it at. Floor
 * unconditionally rather than treating that rounding artifact as "0% used".
 */
export function roundedContextPercent(percent: number): number {
  return Math.max(1, Math.round(percent));
}
