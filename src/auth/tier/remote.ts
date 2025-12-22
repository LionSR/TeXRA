/**
 * Remote configuration fetching for tier-based model access.
 *
 * Fetches tier configuration from the relay server's /tier-config endpoint.
 * The server returns which models and providers are available for each tier.
 */

import { SUPABASE_CUSTOM_DOMAIN } from '../config';
import { TierModelConfigSchema, type TierModelConfig } from './types';
import {
  isCacheValid,
  getCachedPromise,
  setCachePromise,
  updateCacheOnSuccess,
  getCachedConfig,
} from './cache';

const LOG_PREFIX = '[TierConfig]';

/**
 * Fetch tier configuration from the relay server.
 * This is a public endpoint that returns the tier-based model access config.
 */
async function fetchFromServer(): Promise<TierModelConfig | null> {
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
          `${LOG_PREFIX} tier-config endpoint not available, using defaults`,
        );
        return null;
      }
      console.error(
        `${LOG_PREFIX} Failed to fetch tier config: ${response.status}`,
      );
      return null;
    }

    const data = await response.json();
    const parsed = TierModelConfigSchema.safeParse(data);

    if (!parsed.success) {
      console.error(`${LOG_PREFIX} Invalid tier config response:`, parsed.error);
      return null;
    }

    return parsed.data;
  } catch (error) {
    console.error(`${LOG_PREFIX} Error fetching tier config:`, error);
    return null;
  }
}

/**
 * Get the tier configuration from the server.
 * Successful results are cached for 5 minutes.
 * Failed fetches are NOT cached, allowing immediate retry.
 *
 * Returns null if:
 * - Server is unreachable
 * - Endpoint not deployed yet (404)
 * - Invalid response format
 *
 * Callers should fall back to existing behavior when null is returned.
 */
export async function getTierConfig(): Promise<TierModelConfig | null> {
  // Check if cache is still valid (only cache successful fetches)
  if (isCacheValid()) {
    return getCachedPromise();
  }

  // Create new cache entry with proper config sync
  // Set promise synchronously to prevent race conditions - subsequent calls
  // within the same tick will use this promise instead of creating their own.
  // Only update timestamp on successful fetch to allow immediate retry on failure.
  const fetchPromise = fetchFromServer().then((result) => {
    if (result !== null) {
      updateCacheOnSuccess(result);
    }
    return result;
  });

  setCachePromise(fetchPromise);
  return fetchPromise;
}

/**
 * Get the cached tier configuration (synchronous).
 * Returns null if config hasn't been fetched yet.
 */
export function getTierConfigSync(): TierModelConfig | null {
  return getCachedConfig();
}
