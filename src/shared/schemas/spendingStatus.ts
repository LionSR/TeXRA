import { z } from 'zod';

/**
 * Monthly relay spending status for the authenticated user, returned by
 * /tier-config when the request carries a JWT. Spend values are in USD and
 * reflect the calendar month so far (UTC).
 */
export const SpendingStatusSchema = z.object({
  currentSpend: z.number().finite().nonnegative(),
  limit: z.number().finite().nonnegative(),
  remaining: z.number().finite(),
  percentUsed: z.number().finite().nonnegative(),
});
export type SpendingStatus = z.infer<typeof SpendingStatusSchema>;

/**
 * Relay-side spend-check failure, returned by /tier-config alongside a null
 * `spendingStatus` when the server could not compute the user's spend (e.g. a
 * usage-table query failed). Distinguishes "the server failed to check" from
 * "no usage data exists for this account".
 */
export const SpendingStatusErrorSchema = z.object({
  spendCheckFailed: z.boolean(),
  failureReason: z.string().nullish(),
  limit: z.number().finite().nullish(),
});
export type SpendingStatusError = z.infer<typeof SpendingStatusErrorSchema>;

/** The exhausted boundary: single source of truth for `TierService` and the
 *  Settings quota meter, so the two can't drift on what "exhausted" means. */
export function isSpendingQuotaExceeded(status: SpendingStatus): boolean {
  return status.remaining <= 0;
}

/** Percent of the monthly relay quota at which surfaces start warning. */
const WARNING_THRESHOLD_PCT = 80;

export type SpendingQuotaState = 'ok' | 'warning' | 'exhausted';

/** How far into the monthly relay quota the user is. Shared by the Settings
 *  quota meter and the CLI status bar so the two warn at the same point. */
export function spendingQuotaState(status: SpendingStatus): SpendingQuotaState {
  if (isSpendingQuotaExceeded(status)) return 'exhausted';
  if (status.percentUsed >= WARNING_THRESHOLD_PCT) return 'warning';
  return 'ok';
}

/** Whole-percent headroom left in the monthly relay quota, clamped at 0. */
export function spendingQuotaRemainingPercent(status: SpendingStatus): number {
  return Math.max(0, Math.round(100 - Math.min(status.percentUsed, 100)));
}
