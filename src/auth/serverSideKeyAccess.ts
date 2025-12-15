/**
 * Helper for determining server-side API key access.
 *
 * Server-side keys allow Ultra tier users to access AI models without
 * providing their own API keys. The keys are stored as Supabase Edge
 * Function secrets and accessed via the relay function.
 *
 * INITIALIZATION REQUIREMENTS:
 * ----------------------------
 * The `canUseServerSideKeys()` async function MUST be called at least once
 * before `shouldUseServerSideKeysSync()` will return true. This is because:
 *
 * 1. `canUseServerSideKeys()` performs the async authentication and tier check
 * 2. It caches the result in `lastKnownAccessResult`
 * 3. `shouldUseServerSideKeysSync()` uses this cached value for sync decisions
 *
 * Call Sequence:
 * - `canUseServerSideKeys()` is called in `computeModelOptions()` when rendering
 *   the model dropdown, which primes the cache
 * - `shouldUseServerSideKeysSync()` is then safe to call from sync functions
 *   like `resolveBaseUrl()` and `getApiKey()`
 *
 * If `canUseServerSideKeys()` hasn't been called, `shouldUseServerSideKeysSync()`
 * will return false, causing fallback to normal API key behavior.
 */

import { getConfig } from '@utils/config';
import { SupabaseClient } from './SupabaseClient';
import { SUPABASE_CUSTOM_DOMAIN } from './config';

/**
 * Supported providers for server-side API keys.
 * These match the providers configured in the relay Edge Function.
 */
export const SERVER_SIDE_PROVIDERS = [
  'openai',
  'anthropic',
  'google',
  'xai',
  'deepseek',
  'moonshot',
  'dashscope',
] as const;

export type ServerSideProvider = (typeof SERVER_SIDE_PROVIDERS)[number];

/**
 * Cache for server-side key access check.
 * Uses Promise-based caching to avoid race conditions.
 */
let accessCachePromise: Promise<boolean> | null = null;
let accessCacheTimestamp: number = 0;
let lastKnownAccessResult: boolean = false;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Check if the experimental setting for server-side keys is enabled.
 */
export function isServerSideKeysSettingEnabled(): boolean {
  return getConfig<boolean>('texra.experimental.useServerSideKeys', false);
}

/**
 * Clear the access cache. Call this when user signs in/out.
 */
export function clearServerSideKeyAccessCache(): void {
  accessCachePromise = null;
  accessCacheTimestamp = 0;
  lastKnownAccessResult = false;
}

/**
 * Internal function to fetch access status.
 */
async function fetchAccessStatus(): Promise<boolean> {
  const isAuthenticated = await SupabaseClient.isAuthenticated();
  if (!isAuthenticated) {
    lastKnownAccessResult = false;
    return false;
  }

  const tier = await SupabaseClient.getUserTier();
  const hasAccess = tier === 'Ultra';
  lastKnownAccessResult = hasAccess;
  return hasAccess;
}

/**
 * Check if the current user can use server-side API keys.
 *
 * Requirements:
 * 1. The experimental setting must be enabled
 * 2. User must be authenticated
 * 3. User must have Ultra tier
 *
 * Results are cached for 5 minutes to avoid repeated database calls.
 * Uses Promise-based caching to prevent race conditions.
 */
export async function canUseServerSideKeys(): Promise<boolean> {
  // Check setting first (fast, no network)
  if (!isServerSideKeysSettingEnabled()) {
    // Clear entire cache when setting is disabled to ensure fresh check when re-enabled
    // This prevents stale cached promise from being used if setting is toggled back on
    clearServerSideKeyAccessCache();
    return false;
  }

  const now = Date.now();

  // Check if cache is still valid
  if (accessCachePromise && now - accessCacheTimestamp < CACHE_TTL_MS) {
    return accessCachePromise;
  }

  // Create new cache entry (Promise-based to prevent race conditions)
  accessCacheTimestamp = now;
  accessCachePromise = fetchAccessStatus();

  return accessCachePromise;
}

/**
 * Synchronous check if server-side keys should be used for routing.
 *
 * IMPORTANT: This only returns true if:
 * 1. The setting is enabled
 * 2. The provider is supported
 * 3. A previous async check (canUseServerSideKeys) confirmed access
 *
 * PREREQUISITE: canUseServerSideKeys() must have been called and completed
 * before this function will return true. This typically happens when:
 * - computeModelOptions() renders the model dropdown
 * - Any other code path that calls canUseServerSideKeys() first
 *
 * If canUseServerSideKeys() hasn't been called yet or returned false,
 * this will return false to ensure URL routing and API key retrieval
 * stay synchronized. This is intentional - it causes safe fallback to
 * normal API key behavior rather than sending requests to the relay
 * that would fail authentication.
 *
 * This synchronous function is needed because getBaseUrl() is synchronous.
 */
export function shouldUseServerSideKeysSync(provider: string): boolean {
  // Setting must be enabled
  if (!isServerSideKeysSettingEnabled()) {
    return false;
  }

  // Provider must be supported
  if (!isProviderSupportedForServerSideKeys(provider)) {
    return false;
  }

  // Must have confirmed access from a prior async check
  // This ensures routing and API key decisions are synchronized
  return lastKnownAccessResult === true;
}

/**
 * Check if a provider is supported for server-side keys.
 */
export function isProviderSupportedForServerSideKeys(
  provider: string,
): provider is ServerSideProvider {
  return SERVER_SIDE_PROVIDERS.includes(
    provider.toLowerCase() as ServerSideProvider,
  );
}

/**
 * Get the relay Edge Function base URL for a specific provider.
 * The URL structure is: /relay/{provider}/{...apiPath}
 * So for OpenAI, set baseURL to: https://remote.texra.ai/functions/v1/relay/openai
 *
 * @param provider - The provider name (e.g., 'openai', 'anthropic')
 * @returns The relay base URL for the provider
 */
export function getRelayBaseUrl(provider: string): string {
  return `https://${SUPABASE_CUSTOM_DOMAIN}/functions/v1/relay/${provider.toLowerCase()}`;
}
