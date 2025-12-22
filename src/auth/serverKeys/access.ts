/**
 * Access determination for server-side API keys.
 *
 * RESEARCHER ACCESS PROGRAM:
 * All server-side API key access is provided as a convenience for researchers.
 * Users can always choose between server-side keys or their own API keys.
 *
 * TIER-BASED ACCESS (cumulative):
 * - Ultra tier: Access to ALL models via relay (full access)
 * - Max tier: Mid-tier models ($1-3/M) + all free tier models
 * - free tier: Budget models only (under $1/M input)
 */

import { SupabaseClient } from '../SupabaseClient';
import { ULTRA_TIER, FREE_TIER, type UserTier } from '../config';
import {
  getTierConfig,
  getTierConfigSync,
  isModelAvailableForTier,
  isProviderAvailableForTier,
} from '../tier';
import {
  isAccessCacheValid,
  getAccessCachePromise,
  setAccessCachePromise,
  updateAccessCacheTimestamp,
  updateAccessCacheResult,
  getLastKnownAccessResult,
  getCachedUserTier,
  getCachedProviders,
  clearAllCaches,
} from './cache';
import { isEnabled } from './settings';
import { getEnabledProviders } from './providers';

/**
 * Internal function to fetch access status.
 * Returns true if user is authenticated (all tiers get server-side access).
 * Model-level filtering is handled separately by isModelAvailableForTier.
 */
async function fetchAccessStatus(): Promise<boolean> {
  try {
    const isAuthenticated = await SupabaseClient.isAuthenticated();
    if (!isAuthenticated) {
      updateAccessCacheResult(false, null);
      return false;
    }

    const tier = await SupabaseClient.getUserTier();
    // Default to free tier if no tier is set (consistent with relay server)
    updateAccessCacheResult(true, tier || FREE_TIER);
    return true;
  } catch (_err) {
    // On any error (network, auth, etc.), deny access and allow retry
    updateAccessCacheResult(false, null);
    return false;
  }
}

/**
 * Check if the current user can use server-side API keys.
 *
 * Requirements:
 * 1. The setting must be enabled
 * 2. User must be authenticated
 * 3. At least one provider must be enabled on the server
 *
 * Note: Model-level access is determined by the tier configuration.
 * Use canUseServerSideKeysForModel() for model-specific checks.
 *
 * Results are cached for 5 minutes to avoid repeated database calls.
 * Uses Promise-based caching to prevent race conditions.
 *
 * This function also fetches the list of enabled providers and tier config
 * from the server, priming the cache for shouldUseServerSideKeysSync().
 */
export async function canUseServerSideKeys(): Promise<boolean> {
  // Check setting first (fast, no network)
  if (!isEnabled()) {
    // Clear entire cache when setting is disabled
    clearAllCaches();
    return false;
  }

  // Check if cache is still valid
  const cachedTier = getCachedUserTier();
  const tierConfigAvailable =
    cachedTier === ULTRA_TIER || getTierConfigSync() !== null;

  if (isAccessCacheValid() && tierConfigAvailable) {
    const cached = getAccessCachePromise();
    if (cached) {
      return cached;
    }
  }

  // CACHE PATTERN: Promise deduplication with conditional timestamp
  const promise = (async () => {
    // Fetch access status, enabled providers, and tier config in parallel
    const [hasAccess, providers, tierConfig] = await Promise.all([
      fetchAccessStatus(),
      getEnabledProviders(),
      getTierConfig(),
    ]);

    // Only update timestamp if:
    // 1. User has access AND providers are available, AND
    // 2. For non-Ultra tier: tier config was successfully fetched
    const tier = getCachedUserTier();
    const tierConfigRequired = tier !== ULTRA_TIER && tierConfig === null;
    if (hasAccess && providers.length > 0 && !tierConfigRequired) {
      updateAccessCacheTimestamp();
    }

    // Must have access AND at least one enabled provider
    return hasAccess && providers.length > 0;
  })();

  setAccessCachePromise(promise);
  return promise;
}

/**
 * Check if a specific model is available via server-side keys for the current user.
 *
 * This is the model-aware version of canUseServerSideKeys():
 * - Ultra tier: All models available (if provider is enabled)
 * - Max tier: Mid-tier models ($1-3/M) + all free tier models
 * - free tier: Budget models only (under $1/M input)
 *
 * MODEL VALIDATION STRATEGY:
 * - Client validates using SHORT NAMES (e.g., "gpt41-", "gemini25f")
 * - Server validates using API PATTERNS (e.g., "gpt-4.1-mini", "gemini-2.5-flash")
 * - Both are defined in RELAY_MODELS as the single source of truth
 *
 * @param modelName - The model SHORT NAME to check (e.g., "gemini2flash", "opus45T")
 * @returns true if the model is available via server-side keys
 */
export async function canUseServerSideKeysForModel(
  modelName: string,
): Promise<boolean> {
  // First check basic access (tier + setting + providers)
  const hasAccess = await canUseServerSideKeys();
  if (!hasAccess) {
    return false;
  }

  // Use sync version since cache is now primed
  return isModelAvailableForCurrentTierSync(modelName);
}

/**
 * Synchronous check if a model is available for the current user's tier.
 *
 * PREREQUISITE: canUseServerSideKeys() must have been called and completed
 * to prime the caches. If caches are not primed, returns false.
 *
 * @param modelName - The model name to check
 * @returns true if the model is available for the current tier
 */
export function isModelAvailableForCurrentTierSync(modelName: string): boolean {
  const tier = getCachedUserTier();
  if (!tier) {
    return false;
  }

  // Ultra tier gets access to all models
  if (tier === ULTRA_TIER) {
    return true;
  }

  // Max and free tiers need model-level check against tier config
  const config = getTierConfigSync();
  return isModelAvailableForTier(tier, modelName, config);
}

/**
 * Synchronous check if server-side keys should be used for routing.
 *
 * IMPORTANT: This only returns true if:
 * 1. The setting is enabled
 * 2. The provider is enabled on the server (has API key configured)
 * 3. A previous async check (canUseServerSideKeys) confirmed access
 * 4. For non-Ultra tier: the model must be in the tier's allowed list
 *
 * PREREQUISITE: canUseServerSideKeys() must have been called and completed
 * before this function will return true.
 *
 * @param provider - The provider to check (e.g., "openai", "anthropic")
 * @param modelName - Model name for tier-based model-level checks
 */
export function shouldUseServerSideKeysSync(
  provider: string,
  modelName?: string,
): boolean {
  // Setting must be enabled
  if (!isEnabled()) {
    return false;
  }

  // Provider must be enabled on the server (has API key configured)
  const normalizedProvider = provider.toLowerCase();
  if (!getCachedProviders().includes(normalizedProvider)) {
    return false;
  }

  // Must have confirmed access from a prior async check
  if (getLastKnownAccessResult() !== true) {
    return false;
  }

  // For Ultra tier, all models are available
  const tier = getCachedUserTier();
  if (tier === ULTRA_TIER) {
    return true;
  }

  // For Max and free tiers, require both provider AND model validation
  if (!tier || !modelName) {
    return false;
  }
  const config = getTierConfigSync();
  // Check provider is allowed for this tier (not just globally enabled)
  if (!isProviderAvailableForTier(tier, normalizedProvider, config)) {
    return false;
  }
  return isModelAvailableForTier(tier, modelName, config);
}

/**
 * Check if a provider is available for the current user's tier.
 *
 * This combines two checks:
 * 1. Provider must be globally enabled on the server (has API key)
 * 2. Provider must be in the tier's allowed providers list
 *
 * @param provider - The provider to check (e.g., "openai", "anthropic")
 * @returns true if the provider is available for the current user
 */
export function isProviderAvailableForCurrentTier(provider: string): boolean {
  const normalizedProvider = provider.toLowerCase();

  // Must be globally enabled on server
  if (!getCachedProviders().includes(normalizedProvider)) {
    return false;
  }

  // Ultra tier gets all globally enabled providers
  const tier = getCachedUserTier();
  if (tier === ULTRA_TIER) {
    return true;
  }

  // Max and free tiers need tier-specific provider check
  if (!tier) {
    return false;
  }
  const config = getTierConfigSync();
  return isProviderAvailableForTier(tier, normalizedProvider, config);
}

/**
 * Get the cached user tier (synchronous).
 * Returns null if tier hasn't been fetched yet.
 *
 * This is useful for UI components that need to display tier-specific content.
 */
export { getCachedUserTier };
