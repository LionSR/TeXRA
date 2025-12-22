/**
 * TierService - OOP service for tier-based model access.
 *
 * Encapsulates tier configuration fetching, caching, and validation.
 * This replaces the module-level cache functions with a proper class.
 *
 * RESEARCHER ACCESS PROGRAM:
 * All server-side API key access is provided as a convenience for researchers.
 *
 * TIER HIERARCHY (cumulative access):
 * - free: Budget models only (under $1/M input)
 * - Max: Mid-tier models ($1-3/M) + all free tier models
 * - Ultra: All models including premium ($3+/M input)
 */

import { SERVER_SIDE_CACHE_TTL_MS, type UserTier } from '../config';
import { TierModelConfigSchema, type TierModelConfig } from './types';

const LOG_PREFIX = '[TierService]';

/**
 * Service for managing tier-based model access configuration.
 */
export class TierService {
  private cache: TierModelConfig | null = null;
  private cacheTimestamp = 0;
  private fetchPromise: Promise<TierModelConfig | null> | null = null;

  /**
   * Create a new TierService.
   * @param baseUrl - The base URL for the relay server (e.g., "https://remote.texra.ai")
   */
  constructor(private readonly baseUrl: string) {}

  /**
   * Clear the tier config cache.
   * Call this when user signs in/out.
   */
  clearCache(): void {
    this.cache = null;
    this.cacheTimestamp = 0;
    this.fetchPromise = null;
  }

  /**
   * Check if a fetch is in progress or cache is valid (not expired).
   * Does NOT require cache data to be present - checking fetchPromise !== null
   * with valid timestamp is enough to avoid duplicate fetches.
   */
  private isCacheValid(): boolean {
    return (
      this.fetchPromise !== null &&
      Date.now() - this.cacheTimestamp < SERVER_SIDE_CACHE_TTL_MS
    );
  }

  /**
   * Fetch tier configuration from the relay server.
   */
  private async fetchFromServer(): Promise<TierModelConfig | null> {
    try {
      const url = `${this.baseUrl}/functions/v1/relay/tier-config`;
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) {
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
   */
  async getConfig(): Promise<TierModelConfig | null> {
    if (this.isCacheValid()) {
      return this.fetchPromise;
    }

    // Set timestamp BEFORE creating promise to prevent race conditions
    // where concurrent calls see fetchPromise !== null but timestamp is stale
    this.cacheTimestamp = Date.now();
    this.fetchPromise = this.fetchFromServer().then((result) => {
      if (result !== null) {
        this.cache = result;
      } else {
        // Reset timestamp on failure so next call retries
        this.cacheTimestamp = 0;
      }
      return result;
    });

    return this.fetchPromise;
  }

  /**
   * Get the cached tier configuration (synchronous).
   * Returns null if config hasn't been fetched yet.
   */
  getConfigSync(): TierModelConfig | null {
    return this.cache;
  }

  /**
   * Check if a specific model is available for a user tier.
   *
   * @param tier - User's tier (free, Max, Ultra)
   * @param modelName - The model SHORT NAME to check
   * @param config - Optional config override (uses cached if not provided)
   */
  isModelAvailable(
    tier: UserTier,
    modelName: string,
    config?: TierModelConfig | null,
  ): boolean {
    const cfg = config ?? this.cache;
    if (!cfg) {
      return false;
    }

    const tierConfig = cfg.tiers[tier];
    if (!tierConfig) {
      return false;
    }

    if (tierConfig.models === '*') {
      return true;
    }

    return tierConfig.models.includes(modelName);
  }

  /**
   * Check if a provider is enabled for a user tier.
   *
   * @param tier - User's tier (free, Max, Ultra)
   * @param provider - The provider to check (e.g., "google")
   * @param config - Optional config override (uses cached if not provided)
   */
  isProviderAvailable(
    tier: UserTier,
    provider: string,
    config?: TierModelConfig | null,
  ): boolean {
    const cfg = config ?? this.cache;
    if (!cfg) {
      return false;
    }

    const tierConfig = cfg.tiers[tier];
    if (!tierConfig) {
      return false;
    }

    return tierConfig.providers.includes(provider.toLowerCase());
  }

  /**
   * Get the list of allowed models for a specific tier.
   * Returns null if all models are allowed ("*").
   */
  getAllowedModels(
    tier: UserTier,
    config?: TierModelConfig | null,
  ): string[] | null {
    const cfg = config ?? this.cache;
    if (!cfg) {
      return [];
    }

    const tierConfig = cfg.tiers[tier];
    if (!tierConfig) {
      return [];
    }

    if (tierConfig.models === '*') {
      return null;
    }

    return tierConfig.models;
  }

  /**
   * Get the list of enabled providers for a specific tier.
   */
  getEnabledProviders(
    tier: UserTier,
    config?: TierModelConfig | null,
  ): string[] {
    const cfg = config ?? this.cache;
    if (!cfg) {
      return [];
    }

    const tierConfig = cfg.tiers[tier];
    return tierConfig?.providers ?? [];
  }

  /**
   * Get the effective list of providers for a tier, filtered by what's
   * actually enabled on the server.
   *
   * @param tier - User's tier
   * @param config - The tier configuration
   * @param serverEnabledProviders - Providers with API keys on the server
   */
  getEffectiveProviders(
    tier: UserTier,
    config: TierModelConfig | null | undefined,
    serverEnabledProviders: string[],
  ): string[] {
    const tierProviders = this.getEnabledProviders(tier, config);
    const normalizedServerProviders = serverEnabledProviders.map((p) =>
      p.toLowerCase(),
    );
    return tierProviders.filter((p) =>
      normalizedServerProviders.includes(p.toLowerCase()),
    );
  }

  /**
   * Get a user-friendly description of what's included in a tier.
   */
  getAccessDescription(
    tier: UserTier,
    config?: TierModelConfig | null,
  ): string {
    const cfg = config ?? this.cache;
    if (!cfg) {
      return 'No included model access';
    }

    const tierConfig = cfg.tiers[tier];
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
}
