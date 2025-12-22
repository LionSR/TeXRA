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
 */

import { z } from 'zod';
import { UserTierSchema, type UserTier } from '../config';

// Re-export for convenience
export { UserTierSchema, type UserTier };

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
