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

import { toErrorMessage } from '@common/errors/errorMessage';
import { SERVER_SIDE_CACHE_TTL_MS, type UserTier } from '../sharedConfig';
import {
  NOOP_AUTH_SERVICE_LOGGER,
  type AuthServiceLogger,
} from '../serviceLogger';
import {
  TierModelConfigSchema,
  UserAccessStatusSchema,
  type TierModelConfig,
  type TierModelsConfig,
  type UserAccessStatus,
} from './types';
import {
  SpendingStatusSchema,
  type SpendingStatus,
} from '@shared/schemas/spendingStatus';

const CHANNEL = 'TierService';

/**
 * Service for managing tier-based model access configuration.
 */
export class TierService {
  private cache: TierModelConfig | null = null;
  private cacheTimestamp = 0;
  private fetchPromise: Promise<TierModelConfig | null> | null = null;
  /**
   * True when the latest cached fetch carried an Authorization header.
   * A later authenticated call must refresh the cache so userStatus and
   * spendingStatus are populated; otherwise the 5-min TTL would serve
   * stale `null`s until expiry.
   */
  private cachedWithAuth = false;

  /** User's access status including expiration (populated when fetching with auth) */
  private userStatus: UserAccessStatus | null = null;

  /** Latest relay spend snapshot (populated when fetching with auth). */
  private spendingStatus: SpendingStatus | null = null;

  /**
   * Create a new TierService.
   * @param baseUrl - The base URL for the relay server (e.g., "https://remote.texra.ai")
   */
  constructor(
    private readonly baseUrl: string,
    private readonly logger: AuthServiceLogger = NOOP_AUTH_SERVICE_LOGGER,
  ) {}

  /**
   * Clear the tier config cache.
   * Call this when user signs in/out.
   */
  clearCache(): void {
    this.cache = null;
    this.cacheTimestamp = 0;
    this.fetchPromise = null;
    this.userStatus = null;
    this.spendingStatus = null;
    this.cachedWithAuth = false;
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
          this.logger.info(
            CHANNEL,
            'Tier-config endpoint not available, using defaults',
          );
          return null;
        }
        this.logger.error(
          CHANNEL,
          `Failed to fetch tier config: ${response.status}`,
        );
        return null;
      }

      const data = await response.json();

      // Parse user-specific blocks. Both are only present when the
      // request carries auth, so clear them on absence (anonymous fetch)
      // and on parse failure — a relay-side schema drift should not
      // silently serve stale values to the quota meter / BYOK switch.
      if (data.userStatus) {
        const statusParsed = UserAccessStatusSchema.safeParse(data.userStatus);
        if (statusParsed.success) {
          this.userStatus = statusParsed.data;
        } else {
          this.logger.error(
            CHANNEL,
            `Invalid userStatus payload: ${statusParsed.error.message}`,
          );
          this.userStatus = null;
        }
      } else {
        this.userStatus = null;
      }

      if (data.spendingStatus) {
        const spendParsed = SpendingStatusSchema.safeParse(data.spendingStatus);
        if (spendParsed.success) {
          this.spendingStatus = spendParsed.data;
        } else {
          this.logger.error(
            CHANNEL,
            `Invalid spendingStatus payload: ${spendParsed.error.message}`,
          );
          this.spendingStatus = null;
        }
      } else {
        this.spendingStatus = null;
      }

      const parsed = TierModelConfigSchema.safeParse(data);

      if (!parsed.success) {
        this.logger.error(
          CHANNEL,
          `Invalid tier config response: ${parsed.error.message}`,
        );
        return null;
      }

      return parsed.data;
    } catch (error) {
      this.logger.error(
        CHANNEL,
        `Error fetching tier config: ${toErrorMessage(error)}`,
      );
      return null;
    }
  }

  /**
   * Get the tier configuration from the server.
   * Successful results are cached for 5 minutes.
   * @param authToken - Optional JWT to get user-specific access status
   */
  async getConfig(authToken?: string): Promise<TierModelConfig | null> {
    // Reuse an in-flight or fresh cache only when it matches the
    // current auth state. A previous anonymous fetch leaves
    // userStatus/spendingStatus as null; reusing it here would mask
    // the user's quota for 5 minutes after sign-in.
    const tokenPresent = Boolean(authToken);
    if (this.isCacheValid() && this.cachedWithAuth === tokenPresent) {
      return this.fetchPromise;
    }

    // Set timestamp BEFORE creating promise to prevent race conditions
    // where concurrent calls see fetchPromise !== null but timestamp is stale
    this.cacheTimestamp = Date.now();
    this.cachedWithAuth = tokenPresent;
    this.fetchPromise = this.fetchFromServer(authToken).then((result) => {
      if (result !== null) {
        this.cache = result;
      } else {
        // Reset timestamp on failure so next call retries
        this.cacheTimestamp = 0;
        this.cachedWithAuth = false;
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
   * Get tier-specific config from cached or provided config.
   * Returns null if config or tier config not available.
   */
  private getTierConfig(
    tier: UserTier,
    config?: TierModelConfig | null,
  ): TierModelsConfig | null {
    return (config ?? this.cache)?.tiers[tier] ?? null;
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
    const tierConfig = this.getTierConfig(tier, config);
    if (!tierConfig) return false;
    if (tierConfig.models === '*') return true;
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
    const tierConfig = this.getTierConfig(tier, config);
    if (!tierConfig) return [];
    if (tierConfig.models === '*') return null;
    return tierConfig.models;
  }

  /**
   * Get the list of supported providers from the tier config.
   * All tiers have access to the same providers.
   */
  getProviders(config?: TierModelConfig | null): string[] {
    return (config ?? this.cache)?.providers ?? [];
  }

  /**
   * Get a user-friendly description of what's included in a tier.
   */
  getAccessDescription(
    tier: UserTier,
    config?: TierModelConfig | null,
  ): string {
    const tierConfig = this.getTierConfig(tier, config);
    if (!tierConfig) return 'No included model access';
    if (tierConfig.models === '*') return 'All models included';
    const modelCount = tierConfig.models.length;
    if (modelCount === 0) return 'No included model access';
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

  // ===========================================================================
  // Relay Spending Methods
  // ===========================================================================

  /**
   * Latest known relay spend snapshot for the authenticated user, or null
   * if /tier-config hasn't been fetched with auth yet. Cached for the
   * same TTL as the rest of the tier config (5 min) — the BYOK fallback
   * path tolerates slight staleness because the relay still returns a
   * 402 if we underestimate.
   */
  getSpendingStatus(): SpendingStatus | null {
    return this.spendingStatus;
  }

  /**
   * True when the user has exhausted their monthly relay quota. Returns
   * false when status is unknown so we don't false-positive on a
   * transient network failure.
   */
  isQuotaExceeded(): boolean {
    const s = this.spendingStatus;
    return s !== null && s.remaining <= 0;
  }
}
