/**
 * Cache management for tier configuration.
 *
 * Uses promise-based caching with deduplication to prevent race conditions.
 * Only successful fetches are cached; failures allow immediate retry.
 */

import { SERVER_SIDE_CACHE_TTL_MS } from '../config';
import type { TierModelConfig } from './types';

/** Cache state for tier configuration. */
interface TierConfigCache {
  promise: Promise<TierModelConfig | null> | null;
  timestamp: number;
  /** Sync-accessible config (populated when promise resolves). */
  config: TierModelConfig | null;
}

/** Encapsulated cache state. */
const cache: TierConfigCache = {
  promise: null,
  timestamp: 0,
  config: null,
};

/**
 * Clear the tier config cache.
 * Call this when user signs in/out.
 */
export function clearCache(): void {
  cache.promise = null;
  cache.timestamp = 0;
  cache.config = null;
}

/**
 * Check if the cache is valid (not expired and has data).
 */
export function isCacheValid(): boolean {
  return (
    cache.promise !== null &&
    cache.config !== null &&
    Date.now() - cache.timestamp < SERVER_SIDE_CACHE_TTL_MS
  );
}

/**
 * Get the cached promise (may be null).
 */
export function getCachedPromise(): Promise<TierModelConfig | null> | null {
  return cache.promise;
}

/**
 * Get the cached config (synchronous).
 * Returns null if config hasn't been fetched yet.
 */
export function getCachedConfig(): TierModelConfig | null {
  return cache.config;
}

/**
 * Set the cache with a new fetch promise.
 * The promise should call updateCacheOnSuccess when it resolves successfully.
 */
export function setCachePromise(
  promise: Promise<TierModelConfig | null>,
): void {
  cache.promise = promise;
}

/**
 * Update the cache when a fetch succeeds.
 * Called by the fetcher after successful response.
 */
export function updateCacheOnSuccess(config: TierModelConfig): void {
  cache.timestamp = Date.now();
  cache.config = config;
}
