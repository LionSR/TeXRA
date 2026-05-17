/**
 * Type definitions and schemas for tier-based model access.
 *
 * RESEARCHER ACCESS PROGRAM:
 * All server-side API key access is provided as a convenience for researchers.
 * Users can always choose between server-side keys or their own API keys.
 *
 * TIER HIERARCHY (cumulative access):
 * - free: Budget models only (under $1/M input)
 * - Max: Mid-tier models ($1-3/M) + all free tier models
 * - Ultra: All models including premium ($3+/M input)
 *
 * ACCESS EXPIRATION:
 * - All researcher access has an expiration date to prevent abuse
 * - access_expires_at: null = lifetime access (special grants only)
 * - Expired access returns 403 from relay with expired flag
 * - Tier info preserved when expired for easy reactivation
 */

import { z } from 'zod';
import { UserTierSchema, type UserTier } from '../sharedConfig';

// Re-export for convenience
export { UserTierSchema, type UserTier };

/**
 * Schema for user access status including expiration.
 * Returned by the relay /tier-config endpoint for authenticated users.
 */
export const UserAccessStatusSchema = z.object({
  /** User's subscription tier */
  tier: UserTierSchema.nullable(),
  /** When access expires (ISO string), null = no expiration */
  accessExpiresAt: z.string().nullable(),
  /** Whether access is currently expired */
  isExpired: z.boolean(),
  /** Days until expiration (negative if expired, null if no expiration) */
  daysRemaining: z.number().nullable(),
});
export type UserAccessStatus = z.infer<typeof UserAccessStatusSchema>;

/**
 * Monthly relay spending status for the authenticated user, returned by
 * /tier-config when the request carries a JWT. Used to drive both the
 * UI quota meter and the over-limit BYOK fallback. Spend values are in
 * USD and reflect the calendar month so far (UTC).
 */
export const SpendingStatusSchema = z.object({
  currentSpend: z.number(),
  limit: z.number(),
  remaining: z.number(),
  percentUsed: z.number(),
});
export type SpendingStatus = z.infer<typeof SpendingStatusSchema>;

/**
 * Schema for a single tier's model access configuration.
 * - models: Either "*" for all models, or an array of specific model names
 */
export const TierModelsConfigSchema = z.object({
  /** Model access: "*" for all models, or array of specific model names */
  models: z.union([z.literal('*'), z.array(z.string())]),
});
export type TierModelsConfig = z.infer<typeof TierModelsConfigSchema>;

/**
 * Schema for the complete tier configuration response from the server.
 * - providers: All supported providers (same for all tiers)
 * - tiers: Per-tier model access configuration
 */
export const TierModelConfigSchema = z.object({
  /** All supported providers (same for all tiers) */
  providers: z.array(z.string()),
  /** Per-tier model access */
  tiers: z.record(UserTierSchema, TierModelsConfigSchema),
});
export type TierModelConfig = z.infer<typeof TierModelConfigSchema>;
