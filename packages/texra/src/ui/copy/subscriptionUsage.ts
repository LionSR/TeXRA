/**
 * How a subscription's usage reads in every host: its windows, percentages,
 * reset and freshness, as the settings view and the CLI status print them.
 */
import type {
  SubscriptionUsageSnapshot,
  SubscriptionUsageWindow,
} from '@texra/shared/model/subscriptionUsage';
import {
  formatResetDuration,
  FACT_SEPARATOR,
  joinFacts,
} from '@texra-ai/worldline/schemas';
import { formatRelativeTime } from '@ui/copy/format';
import type { RunTone } from '@ui/copy/runStatus';

const STALE_AFTER_MS = 2 * 60_000;

/** Convert provider wire names into compact, stable labels. */
export function subscriptionUsageWindowLabel(
  window: SubscriptionUsageWindow,
): string {
  const separator = window.name.lastIndexOf(':');
  const prefix =
    separator >= 0 ? `${window.name.slice(0, separator + 1)} ` : '';
  const name = window.name.slice(separator + 1).toLowerCase();
  if (/five[_ -]?hour|primary/.test(name)) return `${prefix}5-hour`;
  if (/seven[_ -]?day|weekly|secondary/.test(name)) return `${prefix}7-day`;
  if (/thirty[_ -]?day|monthly/.test(name)) return `${prefix}30-day`;
  return `${prefix}${name.replaceAll('_', ' ')}`;
}

/** The tone a usage window paints with, by what it has left: an error once
 *  it is used up, a caution at a fifth or less, and nothing to say above
 *  that. The CLI status bar and the settings view's meters read it. */
export function subscriptionQuotaTone(
  window: Pick<SubscriptionUsageWindow, 'percentRemaining'>,
): Extract<RunTone, 'warning' | 'danger'> | undefined {
  if (window.percentRemaining <= 0) return 'danger';
  if (window.percentRemaining <= 20) return 'warning';
  return undefined;
}

export function formatSubscriptionUsagePercent(percentUsed: number): string {
  let rounded = Math.round(percentUsed * 10) / 10;
  if (percentUsed > 0 && rounded === 0) rounded = 0.1;
  if (percentUsed < 100 && rounded === 100) rounded = 99.9;
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
}

export function formatSubscriptionUsageReset(
  resetAt: number | undefined,
  now: number,
): string | undefined {
  if (resetAt === undefined) return undefined;
  const remaining = resetAt - now;
  if (remaining <= 0) return 'reset due';
  return `resets in ${formatResetDuration(remaining)}`;
}

export function formatSubscriptionUsageUpdated(
  fetchedAt: number,
  now: number,
): string {
  return now - fetchedAt >= STALE_AFTER_MS
    ? `stale · updated ${formatRelativeTime(fetchedAt, now)}`
    : 'updated just now';
}

/** Compact provider usage text shared by settings and the detailed CLI status. */
export function formatSubscriptionUsageSummary(
  snapshot: SubscriptionUsageSnapshot,
  now: number,
): string | undefined {
  if (snapshot.state === 'unavailable') {
    return snapshot.reason === 'missing_credentials'
      ? undefined
      : 'usage unavailable';
  }
  return snapshot.windows
    .map((window) => {
      const reset = formatSubscriptionUsageReset(window.resetAt, now);
      return joinFacts([
        `${subscriptionUsageWindowLabel(window)}: ${formatSubscriptionUsagePercent(window.percentUsed)}`,
        reset,
      ]);
    })
    .join(FACT_SEPARATOR);
}
