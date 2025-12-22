/**
 * Validation functions for tier-based model and provider access.
 *
 * MODEL VALIDATION STRATEGY:
 * - Client validates using SHORT NAMES (e.g., "gpt41-", "gemini25f")
 * - Server validates using API PATTERNS (e.g., "gpt-4.1-mini", "gemini-2.5-flash")
 * - Both are derived from RELAY_MODELS as the single source of truth
 */

import type { UserTier } from '../config';
import type { TierModelConfig } from './types';

/**
 * Check if a specific model is available for a user tier via server-side keys.
 *
 * @param tier - User's tier (free, Max, Ultra)
 * @param modelName - The model SHORT NAME to check (e.g., "gemini2flash")
 * @param config - The tier configuration (from getTierConfig or getTierConfigSync)
 * @returns true if the model is available for this tier
 */
export function isModelAvailableForTier(
  tier: UserTier,
  modelName: string,
  config: TierModelConfig | null,
): boolean {
  // No config means no tier-based access
  if (!config) {
    return false;
  }

  const tierConfig = config.tiers[tier];
  if (!tierConfig) {
    return false;
  }

  // "*" means all models are available
  if (tierConfig.models === '*') {
    return true;
  }

  // Check if model is in the allowed list
  return tierConfig.models.includes(modelName);
}

/**
 * Check if a provider is enabled for a user tier via server-side keys.
 *
 * @param tier - User's tier (free, Max, Ultra)
 * @param provider - The provider to check (e.g., "google")
 * @param config - The tier configuration
 * @returns true if the provider is enabled for this tier
 */
export function isProviderAvailableForTier(
  tier: UserTier,
  provider: string,
  config: TierModelConfig | null,
): boolean {
  if (!config) {
    return false;
  }

  const tierConfig = config.tiers[tier];
  if (!tierConfig) {
    return false;
  }

  return tierConfig.providers.includes(provider.toLowerCase());
}

/**
 * Get the list of allowed models for a specific tier.
 *
 * @param tier - User's tier
 * @param config - The tier configuration
 * @returns Array of model names, or null if all models are allowed ("*")
 */
export function getAllowedModelsForTier(
  tier: UserTier,
  config: TierModelConfig | null,
): string[] | null {
  if (!config) {
    return [];
  }

  const tierConfig = config.tiers[tier];
  if (!tierConfig) {
    return [];
  }

  // "*" means all models - return null to indicate "all"
  if (tierConfig.models === '*') {
    return null;
  }

  return tierConfig.models;
}

/**
 * Get the list of enabled providers for a specific tier.
 *
 * @param tier - User's tier
 * @param config - The tier configuration
 * @returns Array of provider names
 */
export function getEnabledProvidersForTier(
  tier: UserTier,
  config: TierModelConfig | null,
): string[] {
  if (!config) {
    return [];
  }

  const tierConfig = config.tiers[tier];
  return tierConfig?.providers ?? [];
}

/**
 * Get the effective list of providers for a tier, filtered by what's
 * actually enabled on the server.
 *
 * This combines the tier config with the server's enabled providers list
 * to return only providers that are both allowed for the tier AND have
 * API keys configured on the server.
 *
 * @param tier - User's tier
 * @param config - The tier configuration
 * @param serverEnabledProviders - Providers with API keys on the server
 * @returns Array of provider names that are both tier-allowed and server-enabled
 */
export function getEffectiveProvidersForTier(
  tier: UserTier,
  config: TierModelConfig | null,
  serverEnabledProviders: string[],
): string[] {
  const tierProviders = getEnabledProvidersForTier(tier, config);
  // Normalize to lowercase for case-insensitive comparison
  const normalizedServerProviders = serverEnabledProviders.map((p) =>
    p.toLowerCase(),
  );
  return tierProviders.filter((p) =>
    normalizedServerProviders.includes(p.toLowerCase()),
  );
}

/**
 * Get a user-friendly description of what's included in a tier.
 *
 * @param tier - User's tier
 * @param config - The tier configuration
 * @returns Description string for UI display
 */
export function getTierAccessDescription(
  tier: UserTier,
  config: TierModelConfig | null,
): string {
  if (!config) {
    return 'No included model access';
  }

  const tierConfig = config.tiers[tier];
  if (!tierConfig) {
    return 'No included model access';
  }

  if (tierConfig.models === '*') {
    return 'All models included';
  }

  const modelCount = tierConfig.models.length;
  if (modelCount === 0) {
    return 'No included model access';
  }

  return `${modelCount} model${modelCount === 1 ? '' : 's'} included`;
}
