/**
 * Schemas and types for tier-based model access.
 *
 * RESEARCHER ACCESS PROGRAM:
 * All server-side API key access is provided as a convenience for researchers.
 * Users can always choose between server-side keys or their own API keys.
 *
 * TIER HIERARCHY (model access):
 * - free: input <= $1.5/M AND output <= $9/M
 * - Max: every model
 * - Ultra: every model
 *
 * ACCESS EXPIRATION:
 * - All researcher access has an expiration date to prevent abuse
 * - access_expires_at: null = lifetime access (special grants only)
 * - Expired access returns 403 from relay with expired flag
 * - Tier info preserved when expired for easy reactivation
 */

import { z } from 'zod';
import { UserTierSchema } from '../config';

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
});
export type UserAccessStatus = z.infer<typeof UserAccessStatusSchema>;

/**
 * Schema for a single tier's model access configuration.
 * - models: Either "*" for all models, or an array of specific model names
 */
const TierModelsConfigSchema = z.object({
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
