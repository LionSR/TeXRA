/**
 * Tier-based model access configuration.
 *
 * This module handles remote configuration for which models are available
 * to each user tier without requiring their own API keys.
 *
 * TIER HIERARCHY:
 * - free: No server-side key access (must bring own keys)
 * - Max: Access to a subset of cheaper models via relay
 * - Ultra: Access to ALL models via relay (existing behavior)
 *
 * REMOTE CONFIGURATION:
 * The relay server provides a /relay/tier-config endpoint that returns
 * which models are available for each tier. This allows updating model
 * access without requiring extension updates.
 *
 * Example server response:
 * {
 *   "tiers": {
 *     "Max": {
 *       "models": ["gemini2flash", "deepseekV3", "gemini2flashLite"],
 *       "providers": ["google", "deepseek"]
 *     },
 *     "Ultra": {
 *       "models": "*",
 *       "providers": ["openai", "anthropic", "google", "xai", "deepseek", "moonshot", "dashscope"]
 *     }
 *   }
 * }
 */

import { z } from 'zod';
import { SUPABASE_CUSTOM_DOMAIN, UserTier, UserTierSchema } from './config';

// ============================================================================
// Schema Definitions
// ============================================================================

/**
 * Schema for a single tier's model access configuration.
 * - models: Either "*" for all models, or an array of specific model names
 * - providers: Array of provider names enabled for this tier
 */
export const TierAccessConfigSchema = z.object({
  /** Model access: "*" for all models, or array of specific model names */
  models: z.union([z.literal('*'), z.array(z.string())]),
  /** Providers enabled for this tier */
  providers: z.array(z.string()),
});
export type TierAccessConfig = z.infer<typeof TierAccessConfigSchema>;

/**
 * Schema for the complete tier configuration response from the server.
 */
export const TierModelConfigSchema = z.object({
  tiers: z.record(UserTierSchema, TierAccessConfigSchema),
});
export type TierModelConfig = z.infer<typeof TierModelConfigSchema>;

// ============================================================================
// Cache Management
// ============================================================================

/** Cache TTL for tier configuration (5 minutes). */
const TIER_CONFIG_CACHE_TTL_MS = 5 * 60 * 1000;

/** Cache state for tier configuration. */
interface TierConfigCache {
  promise: Promise<TierModelConfig | null> | null;
  timestamp: number;
  /** Sync-accessible config (populated when promise resolves). */
  config: TierModelConfig | null;
}

/** Encapsulated cache state. */
const tierConfigCache: TierConfigCache = {
  promise: null,
  timestamp: 0,
  config: null,
};

/**
 * Clear the tier config cache. Call this when user signs in/out.
 */
export function clearTierConfigCache(): void {
  tierConfigCache.promise = null;
  tierConfigCache.timestamp = 0;
  tierConfigCache.config = null;
}

// ============================================================================
// Remote Configuration Fetching
// ============================================================================

/**
 * Default tier configuration used when server is unreachable.
 * This ensures graceful degradation - Max users get no access,
 * Ultra users fall back to the enabled providers list from /relay/providers.
 */
const DEFAULT_TIER_CONFIG: TierModelConfig = {
  tiers: {
    free: { models: [], providers: [] },
    Max: { models: [], providers: [] },
    Ultra: { models: '*', providers: [] }, // providers filled from /relay/providers
  },
};

/**
 * Fetch tier configuration from the relay server.
 * This is a public endpoint that returns the tier-based model access config.
 */
async function fetchTierConfigFromServer(): Promise<TierModelConfig | null> {
  try {
    const url = `https://${SUPABASE_CUSTOM_DOMAIN}/functions/v1/relay/tier-config`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      // 404 means endpoint not yet deployed - use default
      if (response.status === 404) {
        console.log(
          '[TierModelAccess] tier-config endpoint not available, using defaults',
        );
        return null;
      }
      console.error(
        `[TierModelAccess] Failed to fetch tier config: ${response.status}`,
      );
      return null;
    }

    const data = await response.json();
    const parsed = TierModelConfigSchema.safeParse(data);

    if (!parsed.success) {
      console.error(
        '[TierModelAccess] Invalid tier config response:',
        parsed.error,
      );
      return null;
    }

    tierConfigCache.config = parsed.data;
    return parsed.data;
  } catch (error) {
    console.error('[TierModelAccess] Error fetching tier config:', error);
    return null;
  }
}

/**
 * Get the tier configuration from the server.
 * Results are cached for 5 minutes.
 *
 * Returns null if:
 * - Server is unreachable
 * - Endpoint not deployed yet (404)
 * - Invalid response format
 *
 * Callers should fall back to existing behavior when null is returned.
 */
export async function getTierConfig(): Promise<TierModelConfig | null> {
  const now = Date.now();

  // Check if cache is still valid
  if (
    tierConfigCache.promise &&
    now - tierConfigCache.timestamp < TIER_CONFIG_CACHE_TTL_MS
  ) {
    return tierConfigCache.promise;
  }

  // Create new cache entry
  tierConfigCache.timestamp = now;
  tierConfigCache.promise = fetchTierConfigFromServer();

  return tierConfigCache.promise;
}

/**
 * Get the cached tier configuration (synchronous).
 * Returns null if config hasn't been fetched yet.
 */
export function getTierConfigSync(): TierModelConfig | null {
  return tierConfigCache.config;
}

// ============================================================================
// Model Access Checks
// ============================================================================

/**
 * Check if a specific model is available for a user tier via server-side keys.
 *
 * @param tier - User's tier (free, Max, Ultra)
 * @param modelName - The model name to check (e.g., "gemini2flash")
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

  // Free tier never gets server-side key access
  if (tier === 'free') {
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
  if (!config || tier === 'free') {
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
  if (!config || tier === 'free') {
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
  if (!config || tier === 'free') {
    return [];
  }

  const tierConfig = config.tiers[tier];
  return tierConfig?.providers ?? [];
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
  if (!config || tier === 'free') {
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
