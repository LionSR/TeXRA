/**
 * Tier-based model access module.
 *
 * This module handles configuration for which models are available
 * to each user tier without requiring their own API keys.
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

// Types
export {
  TierAccessConfigSchema,
  TierModelConfigSchema,
  type TierAccessConfig,
  type TierModelConfig,
  type UserTier,
} from './types';

// Cache management
export { clearCache as clearTierConfigCache } from './cache';

// Remote fetching
export { getTierConfig, getTierConfigSync } from './remote';

// Validation
export {
  isModelAvailableForTier,
  isProviderAvailableForTier,
  getAllowedModelsForTier,
  getEnabledProvidersForTier,
  getEffectiveProvidersForTier,
  getTierAccessDescription,
} from './validation';
