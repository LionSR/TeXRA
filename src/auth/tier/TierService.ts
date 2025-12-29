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
import {
  TierModelConfigSchema,
  UserAccessStatusSchema,
  type TierModelConfig,
  type UserAccessStatus,
} from './types';
import * as logger from '@logger/logUtils';

const CHANNEL = 'TierService';

/**
 * Service for managing tier-based model access configuration.
 */
export class TierService {
  private cache: TierModelConfig | null = null;
  private cacheTimestamp = 0;
  private fetchPromise: Promise<TierModelConfig | null> | null = null;

  /** User's access status including expiration (populated when fetching with auth) */
  private userStatus: UserAccessStatus | null = null;

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
    this.userStatus = null;
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
   * @param authToken - Optional JWT token to include user access status in response
   */
  private async fetchFromServer(
    authToken?: string,
  ): Promise<TierModelConfig | null> {
    try {
      const url = `${this.baseUrl}/functions/v1/relay/tier-config`;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      // Include auth token if provided to get user-specific status
      if (authToken) {
        headers['Authorization'] = `Bearer ${authToken}`;
      }

      const response = await fetch(url, { method: 'GET', headers });

      if (!response.ok) {
        if (response.status === 404) {
          logger.info(
            CHANNEL,
            'Tier-config endpoint not available, using defaults',
          );
          return null;
        }
        logger.error(
          CHANNEL,
          `Failed to fetch tier config: ${response.status}`,
        );
        return null;
      }

      const data = await response.json();

      // Parse user status if present (returned when authenticated)
      if (data.userStatus) {
        const statusParsed = UserAccessStatusSchema.safeParse(data.userStatus);
        if (statusParsed.success) {
          this.userStatus = statusParsed.data;
        }
      }

      const parsed = TierModelConfigSchema.safeParse(data);

      if (!parsed.success) {
        logger.error(
          CHANNEL,
          `Invalid tier config response: ${parsed.error.message}`,
        );
        return null;
      }

      return parsed.data;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(CHANNEL, `Error fetching tier config: ${message}`);
      return null;
    }
  }

  /**
   * Get the tier configuration from the server.
   * Successful results are cached for 5 minutes.
   * @param authToken - Optional JWT to get user-specific access status
   */
  async getConfig(authToken?: string): Promise<TierModelConfig | null> {
    if (this.isCacheValid()) {
      return this.fetchPromise;
    }

    // Set timestamp BEFORE creating promise to prevent race conditions
    // where concurrent calls see fetchPromise !== null but timestamp is stale
    this.cacheTimestamp = Date.now();
    this.fetchPromise = this.fetchFromServer(authToken).then((result) => {
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
   * Get the list of supported providers from the tier config.
   * All tiers have access to the same providers.
   */
  getProviders(config?: TierModelConfig | null): string[] {
    const cfg = config ?? this.cache;
    return cfg?.providers ?? [];
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

  // ===========================================================================
  // Access Expiration Methods
  // ===========================================================================

  /**
   * Check if the user's access has expired.
   * Returns false if no expiration info available (allows access).
   */
  isAccessExpired(): boolean {
    return this.userStatus?.isExpired ?? false;
  }

  /**
   * Get the access expiration date.
   * Returns null if no expiration (lifetime access) or status not available.
   */
  getExpirationDate(): Date | null {
    const expiresAt = this.userStatus?.accessExpiresAt;
    return expiresAt ? new Date(expiresAt) : null;
  }
}
