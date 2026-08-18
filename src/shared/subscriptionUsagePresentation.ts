import { differenceInMinutes } from 'date-fns';

import type {
  SubscriptionUsageSnapshot,
  SubscriptionUsageWindow,
} from '@shared/schemas';

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
  now = Date.now(),
): string | undefined {
  if (resetAt === undefined) return undefined;
  const remaining = resetAt - now;
  if (remaining <= 0) return 'reset due';
  const minutes = Math.max(1, Math.floor(remaining / 60_000));
  const days = Math.floor(minutes / (24 * 60));
  const hours = Math.floor((minutes % (24 * 60)) / 60);
  if (days > 0) return `resets in ${days}d${hours > 0 ? ` ${hours}h` : ''}`;
  if (hours > 0) return `resets in ${hours}h`;
  return `resets in ${minutes}m`;
}

export function formatSubscriptionUsageUpdated(
  fetchedAt: number,
  now = Date.now(),
): string {
  const age = Math.max(0, now - fetchedAt);
  if (age >= STALE_AFTER_MS) {
    const minutes = differenceInMinutes(now, fetchedAt);
    return `stale · updated ${minutes}m ago`;
  }
  return 'updated just now';
}

/** Compact provider usage text shared by settings and the detailed CLI status. */
export function formatSubscriptionUsageSummary(
  snapshot: SubscriptionUsageSnapshot,
  now = Date.now(),
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
