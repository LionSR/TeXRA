/**
 * Server-side API key access module.
 *
 * RESEARCHER ACCESS PROGRAM:
 * All server-side API key access is provided as a convenience for researchers.
 * Users can always choose between server-side keys or their own API keys.
 *
 * TIER-BASED ACCESS (cumulative):
 * - Ultra tier: Access to ALL models via relay (full access)
 * - Max tier: Mid-tier models ($1-3/M) + all free tier models
 * - free tier: Budget models only (under $1/M input)
 *
 * ARCHITECTURE:
 * - types.ts: Type definitions
 * - cache.ts: Cache management for providers and access
 * - settings.ts: User preference for included vs personal keys
 * - providers.ts: Fetching enabled providers from server
 * - access.ts: Access determination functions
 * - routing.ts: Relay URL generation
 */

// Types
export { SERVER_SIDE_PROVIDERS, type ServerSideProvider } from './types';

// Settings
export {
  initialize as initializeServerSideKeyAccess,
  isEnabled as isServerSideKeysSettingEnabled,
  getUseIncludedModelAccess,
  onDidChangeModelAccess,
} from './settings';
import {
  setUseIncludedModelAccess as _setUseIncludedModelAccess,
} from './settings';
import { getEnabledProviders } from './providers';
import { getTierConfig } from '../tier';

/**
 * Set the "use included model access" preference.
 * When enabling, pre-fetches providers and tier config.
 */
export async function setUseIncludedModelAccess(value: boolean): Promise<void> {
  await _setUseIncludedModelAccess(value, async () => {
    await Promise.all([getEnabledProviders(), getTierConfig()]);
  });
}

// Cache
export { clearAllCaches as clearServerSideKeyAccessCache } from './cache';

// Providers
export {
  getEnabledProviders,
  getEnabledProvidersSync,
  isProviderEnabledForServerSideKeys,
} from './providers';

// Access
export {
  canUseServerSideKeys,
  canUseServerSideKeysForModel,
  isModelAvailableForCurrentTierSync,
  shouldUseServerSideKeysSync,
  isProviderAvailableForCurrentTier,
  getCachedUserTier,
} from './access';

// Routing
export { getRelayBaseUrl } from './routing';
