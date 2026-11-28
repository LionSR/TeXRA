/**
 * How a subscription's usage reads in every host: its windows, percentages,
 * reset and freshness, as the settings view and the CLI status print them.
 */
import type {
  PlanUsage,
  SubscriptionUsageWindow,
} from '@texra/shared/model/subscriptionUsage';
import {
  formatResetDuration,
  FACT_SEPARATOR,
  joinFacts,
} from '@texra-ai/worldline/schemas';
import { formatRelativeTime } from '@ui/copy/format';
import { modelAvailabilityLabel } from '@ui/copy/modelAccess';
import type { RunTone } from '@ui/copy/runStatus';

const STALE_AFTER_MS = 2 * 60_000;

/** The plan as its provider names its tier, else as TeXRA names the plan. */
export const planUsageName = (usage: PlanUsage): string =>
  usage.planName ??
  modelAvailabilityLabel({
    availability: 'subscription-access',
    usageRoute: usage.plan,
  });

/** A plan's windows still running at `now`: a figure learned before its
 *  window reset says nothing about the window that followed. */
export const currentUsageWindows = (
  usage: PlanUsage,
  now: number,
): readonly SubscriptionUsageWindow[] =>
  usage.windows.filter(
    (window) => window.resetAt === undefined || window.resetAt > now,
  );

/** The window a one-figure meter stands for: the one the plan runs out of
 *  first, the most used, whichever windows the plan has. */
export const limitingUsageWindow = (
  windows: readonly SubscriptionUsageWindow[],
): SubscriptionUsageWindow | undefined =>
  windows.toSorted((a, b) => b.percentUsed - a.percentUsed).at(0);

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

/** The tone a usage window paints with, by how much is used: an error once it
 *  is used up, a caution at four fifths or more, and nothing to say below
 *  that. The CLI status bar and the settings view's meters read it. */
export function subscriptionQuotaTone(
  window: Pick<SubscriptionUsageWindow, 'percentUsed'>,
): Extract<RunTone, 'warning' | 'danger'> | undefined {
  if (window.percentUsed >= 100) return 'danger';
  if (window.percentUsed >= 80) return 'warning';
  return undefined;
}

/** A window's usage as every host words it, the percent used: "30% used".
 *  A window that has started reads at least 0.1%, and one not yet used up
 *  at most 99.9%, so rounding never says "0%" or "100%" when it is not. */
export function subscriptionQuotaUsed(
  window: Pick<SubscriptionUsageWindow, 'percentUsed'>,
): string {
  const { percentUsed } = window;
  let rounded = Math.round(percentUsed * 10) / 10;
  if (percentUsed > 0 && rounded === 0) rounded = 0.1;
  if (percentUsed < 100 && rounded === 100) rounded = 99.9;
  return `${rounded}% used`;
}

/** When a window still running at `now` (`currentUsageWindows`) resets. */
export function formatSubscriptionUsageReset(
  resetAt: number | undefined,
  now: number,
): string | undefined {
  if (resetAt === undefined) return undefined;
  return `resets in ${formatResetDuration(resetAt - now)}`;
}

export function formatSubscriptionUsageUpdated(
  fetchedAt: number,
  now: number,
): string {
  return now - fetchedAt >= STALE_AFTER_MS
    ? joinFacts(['stale', `updated ${formatRelativeTime(fetchedAt, now)}`])
    : 'updated just now';
}

/** Why a plan shows no windows, as the settings page and the status bar
 *  both say it. */
export function subscriptionUsageUnavailable(
  reason: NonNullable<PlanUsage['unknown']>,
): string {
  switch (reason) {
    case 'unobserved':
      return 'Usage shows after the next reply on this plan.';
    case 'invalid_credentials':
      return 'The provider rejected the configured credentials.';
    case 'malformed_response':
      return 'The provider returned usage data TeXRA could not read.';
    case 'missing_credentials':
    case 'request_failed':
      return 'The provider usage request failed. Try refreshing again shortly.';
  }
}

/** Compact provider usage text for the detailed CLI status. */
export function formatSubscriptionUsageSummary(
  usage: PlanUsage,
  now: number,
): string | undefined {
  if (usage.unknown === 'missing_credentials') return undefined;
  if (usage.unknown !== undefined) return 'usage unavailable';
  return (
    currentUsageWindows(usage, now)
      .map((window) => {
        const reset = formatSubscriptionUsageReset(window.resetAt, now);
        return joinFacts([
          `${subscriptionUsageWindowLabel(window)}: ${subscriptionQuotaUsed(window)}`,
          reset,
        ]);
      })
      .join(FACT_SEPARATOR) || undefined
  );
}
