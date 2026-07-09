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

/** The exhausted boundary: single source of truth for `TierService` and the
 *  Settings quota meter, so the two can't drift on what "exhausted" means. */
export function isSpendingQuotaExceeded(status: SpendingStatus): boolean {
  return status.remaining <= 0;
}
