/**
 * Tier-based model access configuration.
 *
 * @deprecated Import from '@auth/tier' instead.
 * This file re-exports from the new modular structure for backward compatibility.
 */

// Re-export everything from the new tier module
export {
  // Types
  TierAccessConfigSchema,
  TierModelConfigSchema,
  type TierAccessConfig,
  type TierModelConfig,
  // Cache
  clearTierConfigCache,
  // Remote
  getTierConfig,
  getTierConfigSync,
  // Validation
  isModelAvailableForTier,
  isProviderAvailableForTier,
  getAllowedModelsForTier,
  getEnabledProvidersForTier,
  getEffectiveProvidersForTier,
  getTierAccessDescription,
} from './tier';
