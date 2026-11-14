/**
 * How a subscription's usage reads in every host: its windows, percentages,
 * reset and freshness, as the settings view and the CLI status print them.
 */
import type {
  SubscriptionUsageSnapshot,
  SubscriptionUsageWindow,
} from '@texra/shared/model/subscriptionUsage';
import { formatResetDuration } from '@texra-ai/harness/schemas';
import { formatRelativeTime } from '@ui/copy/format';

const STALE_AFTER_MS = 2 * 60_000;

function formatWindowDuration(seconds: number): string | undefined {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}-day`;
  if (seconds % 3600 === 0) return `${seconds / 3600}-hour`;
  return undefined;
}

/** Convert provider wire names into compact, stable labels. */
export function subscriptionUsageWindowLabel(
  window: SubscriptionUsageWindow,
): string {
  const duration = window.limitWindowSeconds
    ? formatWindowDuration(window.limitWindowSeconds)
    : undefined;
  if (duration) return duration;

  const separator = window.name.lastIndexOf(':');
  const prefix =
    separator >= 0 ? `${window.name.slice(0, separator + 1)} ` : '';
  const name = window.name.slice(separator + 1).toLowerCase();
  if (/five[_ -]?hour|primary/.test(name)) return `${prefix}5-hour`;
  if (/seven[_ -]?day|weekly|secondary/.test(name)) return `${prefix}7-day`;
  if (/thirty[_ -]?day|monthly/.test(name)) return `${prefix}30-day`;
  return `${prefix}${name.replaceAll('_', ' ')}`;
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
      return `${subscriptionUsageWindowLabel(window)}: ${formatSubscriptionUsagePercent(window.percentUsed)}${reset ? ` · ${reset}` : ''}`;
    })
    .join(' · ');
}
