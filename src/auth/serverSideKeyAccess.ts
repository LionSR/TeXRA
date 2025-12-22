/**
 * Helper for determining server-side API key access.
 *
 * @deprecated Import from '@auth/serverKeys' instead.
 * This file re-exports from the new modular structure for backward compatibility.
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

// Re-export everything from the new serverKeys module
export {
  // Types
  SERVER_SIDE_PROVIDERS,
  type ServerSideProvider,
  // Settings
  initializeServerSideKeyAccess,
  isServerSideKeysSettingEnabled,
  getUseIncludedModelAccess,
  setUseIncludedModelAccess,
  onDidChangeModelAccess,
  // Cache
  clearServerSideKeyAccessCache,
  // Providers
  getEnabledProviders,
  getEnabledProvidersSync,
  isProviderEnabledForServerSideKeys,
  // Access
  canUseServerSideKeys,
  canUseServerSideKeysForModel,
  isModelAvailableForCurrentTierSync,
  shouldUseServerSideKeysSync,
  isProviderAvailableForCurrentTier,
  getCachedUserTier,
  // Routing
  getRelayBaseUrl,
} from './serverKeys';

// Re-export tier functions that were originally in this file
export {
  getTierConfig,
  getTierConfigSync,
  isModelAvailableForTier,
  isProviderAvailableForTier,
  clearTierConfigCache,
} from './tier';
