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
 * Rounds context-window utilization for display, flooring any genuinely
 * nonzero reading at 1% so it never reads as "0% context used".
 */
export function roundedContextPercent(percent: number): number {
  return percent > 0 ? Math.max(1, Math.round(percent)) : 0;
}
