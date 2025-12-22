/**
 * Cache management for server-side API key access.
 *
 * Manages two caches:
 * 1. Provider cache: List of providers with API keys configured on server
 * 2. Access cache: Whether current user has server-side key access
 */

import { SERVER_SIDE_CACHE_TTL_MS, type UserTier } from '../config';
import { clearTierConfigCache } from '../tier';
import type { ProvidersCache, AccessCache } from './types';

/** Encapsulated cache state for providers. */
const providersCache: ProvidersCache = {
  promise: null,
  timestamp: 0,
  providers: [],
};

/** Encapsulated cache state for access checks. */
const accessCache: AccessCache = {
  promise: null,
  timestamp: 0,
  lastKnownResult: false,
  userTier: null,
};

// ============================================================================
// Providers Cache
// ============================================================================

/**
 * Check if the providers cache is valid.
 */
export function isProvidersCacheValid(): boolean {
  return (
    providersCache.promise !== null &&
    Date.now() - providersCache.timestamp < SERVER_SIDE_CACHE_TTL_MS
  );
}

/**
 * Get the cached providers promise.
 */
export function getProvidersCachePromise(): Promise<string[]> | null {
  return providersCache.promise;
}

/**
 * Get the cached providers list (synchronous).
 */
export function getCachedProviders(): string[] {
  return providersCache.providers;
}

/**
 * Set the providers cache with a new promise.
 */
export function setProvidersCachePromise(promise: Promise<string[]>): void {
  providersCache.timestamp = Date.now();
  providersCache.promise = promise;
}

/**
 * Update the providers cache when fetch succeeds.
 */
export function updateProvidersCacheOnSuccess(providers: string[]): void {
  providersCache.providers = providers;
}

// ============================================================================
// Access Cache
// ============================================================================

/**
 * Check if the access cache is valid.
 * @param requireTierConfig - If true, also checks that tier config is available for non-Ultra
 */
export function isAccessCacheValid(requireTierConfig: boolean = false): boolean {
  if (
    accessCache.promise === null ||
    Date.now() - accessCache.timestamp >= SERVER_SIDE_CACHE_TTL_MS
  ) {
    return false;
  }

  // For Max/free tier, also require tier config to be available
  if (requireTierConfig && accessCache.userTier !== 'Ultra') {
    // This will be checked by the caller using getTierConfigSync
    return true;
  }

  return true;
}

/**
 * Get the cached access promise.
 */
export function getAccessCachePromise(): Promise<boolean> | null {
  return accessCache.promise;
}

/**
 * Get the last known access result (synchronous).
 */
export function getLastKnownAccessResult(): boolean {
  return accessCache.lastKnownResult;
}

/**
 * Get the cached user tier (synchronous).
 */
export function getCachedUserTier(): UserTier | null {
  return accessCache.userTier;
}

/**
 * Set the access cache with a new promise.
 */
export function setAccessCachePromise(promise: Promise<boolean>): void {
  accessCache.promise = promise;
}

/**
 * Update the access cache timestamp on success.
 */
export function updateAccessCacheTimestamp(): void {
  accessCache.timestamp = Date.now();
}

/**
 * Update the access cache result.
 */
export function updateAccessCacheResult(
  result: boolean,
  tier: UserTier | null,
): void {
  accessCache.lastKnownResult = result;
  accessCache.userTier = tier;
}

// ============================================================================
// Clear All Caches
// ============================================================================

/**
 * Clear all server-side key access caches.
 * Call this when user signs in/out.
 */
export function clearAllCaches(): void {
  accessCache.promise = null;
  accessCache.timestamp = 0;
  accessCache.lastKnownResult = false;
  accessCache.userTier = null;
  providersCache.providers = [];
  providersCache.timestamp = 0;
  providersCache.promise = null;
  // Also clear tier config cache
  clearTierConfigCache();
}
