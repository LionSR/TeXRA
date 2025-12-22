/**
 * Provider management for server-side API keys.
 *
 * Handles fetching and caching the list of providers that have
 * API keys configured on the relay server.
 */

import { SUPABASE_CUSTOM_DOMAIN } from '../config';
import {
  isProvidersCacheValid,
  getProvidersCachePromise,
  setProvidersCachePromise,
  updateProvidersCacheOnSuccess,
  getCachedProviders,
} from './cache';

const LOG_PREFIX = '[ServerSideKeys]';

/**
 * Fetch list of enabled providers from the relay server.
 * This is a public endpoint that returns providers with configured API keys.
 */
async function fetchFromServer(): Promise<string[]> {
  try {
    const url = `https://${SUPABASE_CUSTOM_DOMAIN}/functions/v1/relay/providers`;
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      console.error(
        `${LOG_PREFIX} Failed to fetch providers: ${response.status}`,
      );
      return [];
    }

    const data = await response.json();
    if (Array.isArray(data.providers)) {
      updateProvidersCacheOnSuccess(data.providers);
      return data.providers;
    }

    return [];
  } catch (error) {
    console.error(`${LOG_PREFIX} Error fetching providers:`, error);
    return [];
  }
}

/**
 * Get the list of enabled providers from the relay server.
 * Results are cached for 5 minutes.
 */
export async function getEnabledProviders(): Promise<string[]> {
  // Check if cache is still valid
  if (isProvidersCacheValid()) {
    const cached = getProvidersCachePromise();
    if (cached) {
      return cached;
    }
  }

  // Create new cache entry
  const promise = fetchFromServer();
  setProvidersCachePromise(promise);

  return promise;
}

/**
 * Get the cached list of enabled providers (synchronous).
 * Returns empty array if providers haven't been fetched yet.
 */
export function getEnabledProvidersSync(): string[] {
  return getCachedProviders();
}

/**
 * Check if a provider is enabled for server-side keys on the server.
 *
 * This checks against the cached list of enabled providers fetched from
 * the relay server. Returns false if providers haven't been fetched yet.
 *
 * Note: This only checks the GLOBAL providers list, not tier-specific restrictions.
 */
export function isProviderEnabledForServerSideKeys(provider: string): boolean {
  return getCachedProviders().includes(provider.toLowerCase());
}
