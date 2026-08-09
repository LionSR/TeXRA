/**
 * TierService - OOP service for tier-based model access.
 *
 * Encapsulates tier configuration fetching, caching, and validation.
 * This replaces the module-level cache functions with a proper class.
 *
 * RESEARCHER ACCESS PROGRAM:
 * All server-side API key access is provided as a convenience for researchers.
 *
 * TIER HIERARCHY (model access):
 * - free: input <= $1.5/M AND output <= $9/M
 * - Max: every model
 * - Ultra: every model
 */

import { LRUCache } from 'lru-cache';

import { z } from 'zod';
import {
  isSpendingQuotaExceeded,
  SpendingStatusErrorSchema,
  SpendingStatusSchema,
  type SpendingStatus,
  type SpendingStatusError,
} from '@shared/schemas/spendingStatus';
import { toErrorMessage } from '@utils/errors/errorMessage';
import {
  relayTierConfigUrl,
  SERVER_SIDE_CACHE_TTL_MS,
  type UserTier,
} from '../config';
import {
  TierModelConfigSchema,
  UserAccessStatusSchema,
  type TierModelConfig,
  type TierModelsConfig,
  type UserAccessStatus,
} from './tierTypes';
import type { SupabaseSessionLog } from '../supabaseSessionTypes';

const CHANNEL = 'TierService';

/** Cache slot key — auth and anonymous responses never share a slot. */
type TierCacheKey = 'auth' | 'anon';

/** Per-fetch context threaded through {@link LRUCache.fetch} to fetchMethod. */
interface TierFetchContext {
  authToken: string | undefined;
}

/** Result of a single relay `/tier-config` response. */
interface TierFetchResult {
  config: TierModelConfig | null;
  userStatus: UserAccessStatus | null;
  spendingStatus: SpendingStatus | null;
  spendingStatusError: SpendingStatusError | null;
}

/**
 * Service for managing tier-based model access configuration.
 */
export class TierService {
  /**
   * Dedupes concurrent `/tier-config` fetches and gates them on the 5-min TTL.
   *
   * Keyed by auth state so an anonymous fetch and an authenticated fetch never
   * share a slot: a late anonymous response can't clobber the authenticated
   * spend snapshot (this is structural, not timing-dependent — it replaces the
   * former `fetchGeneration` guard). Clearing the cache aborts any in-flight
   * fetch via its `AbortSignal`, so a response that lands after sign-out can't
   * repopulate the snapshots below.
   */
  private readonly configCache: LRUCache<
    TierCacheKey,
    TierModelConfig,
    TierFetchContext
  >;

  /**
   * Last successfully fetched config, backing the synchronous accessors.
   * Persists past the cache TTL until the next fetch or {@link clearCache}.
   */
  private configSnapshot: TierModelConfig | null = null;

  /** User's access status including expiration (populated when fetching with auth) */
  private userStatus: UserAccessStatus | null = null;

  /** Latest relay spend snapshot (populated when fetching with auth). */
  private spendingStatus: SpendingStatus | null = null;

  /** Latest relay spend-check failure (populated when fetching with auth). */
  private spendingStatusError: SpendingStatusError | null = null;

  /**
   * Create a new TierService.
   * @param baseUrl - The base URL for the relay server (e.g., "https://remote.texra.ai")
   */
  constructor(
    private readonly baseUrl: string,
    private readonly logger: SupabaseSessionLog = {},
  ) {
    this.configCache = new LRUCache<
      TierCacheKey,
      TierModelConfig,
      TierFetchContext
    >({
      max: 2,
      ttl: SERVER_SIDE_CACHE_TTL_MS,
      fetchMethod: async (key, _staleValue, { signal, context }) => {
        const result = await this.fetchFromServer(context.authToken, signal);
        // A sign-out (clearCache) during the fetch aborts the signal; never let
        // a stale response repopulate the snapshots after invalidation.
        if (signal.aborted) {
          throw new Error('tier-config fetch aborted');
        }
        // An authenticated response carries the user blocks even when the tiers
        // block fails validation; mirror the previous behaviour of refreshing
        // the quota snapshot whenever auth was present. Anonymous responses
        // never touch these — that is what protects an authenticated snapshot.
        if (key === 'auth') {
          this.userStatus = result.userStatus;
          this.spendingStatus = result.spendingStatus;
          this.spendingStatusError = result.spendingStatusError;
          if (result.spendingStatusError) {
            this.logger.warn?.(CHANNEL, 'Relay spend check failed', {
              data: {
                failureReason:
                  result.spendingStatusError.failureReason ?? 'unknown reason',
              },
            });
          }
        }
        if (result.config === null) {
          // Throw so lru-cache drops the entry and the next call retries,
          // matching the previous "reset timestamp on failure" behaviour
          // (no negative caching of a missing/invalid config).
          throw new Error('tier-config response had no usable config');
        }
        this.configSnapshot = result.config;
        return result.config;
      },
    });
  }

  /**
   * Clear the tier config cache.
   * Call this when user signs in/out.
   */
  clearCache(): void {
    // clear() aborts any in-flight fetch (see fetchMethod's signal guard).
    this.configCache.clear();
    this.configSnapshot = null;
    this.userStatus = null;
    this.spendingStatus = null;
    this.spendingStatusError = null;
  }

  /**
   * Parse an optional user-specific block returned by the relay. Returns
   * null when the block is absent or fails validation; parse failures are
   * logged so relay-side schema drift is visible.
   */
  private parseOptionalBlock<T>(
    raw: unknown,
    schema: z.ZodType<T>,
    label: string,
  ): T | null {
    if (raw == null) return null;
    const parsed = schema.safeParse(raw);
    if (parsed.success) return parsed.data;
    this.logger.error?.(
      CHANNEL,
      `Invalid ${label} payload: ${z.prettifyError(parsed.error)}`,
    );
    return null;
  }

  /**
   * Fetch tier configuration from the relay server.
   *
   * Pure with respect to instance state — the caller (fetchMethod) owns the
   * snapshot updates so invalidation stays in one place. Throws on a transport
   * failure (network error, non-OK, 404) so the cache drops the entry and the
   * next call retries; returns a result with `config: null` when a real 200
   * response failed config validation but may still carry the user blocks.
   *
   * @param authToken - Optional JWT token to include user access status in response
   * @param signal - Abort signal from the cache; cancels the in-flight request
   */
  private async fetchFromServer(
    authToken: string | undefined,
    signal: AbortSignal,
  ): Promise<TierFetchResult> {
    const url = relayTierConfigUrl(this.baseUrl);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Include auth token if provided to get user-specific status
    if (authToken) {
      headers['Authorization'] = `Bearer ${authToken}`;
    }

    let response: Response;
    try {
      response = await fetch(url, { method: 'GET', headers, signal });
    } catch (error) {
      // A sign-out (clearCache) aborts the request; that is expected, so stay
      // quiet. Genuine network failures keep the previous error log.
      if (!signal.aborted) {
        this.logger.error?.(
          CHANNEL,
          `Error fetching tier config: ${toErrorMessage(error)}`,
        );
      }
      throw error;
    }

    if (!response.ok) {
      if (response.status === 404) {
        this.logger.info?.(
          CHANNEL,
          'Tier-config endpoint not available, using defaults',
        );
      } else {
        this.logger.error?.(
          CHANNEL,
          `Failed to fetch tier config: ${response.status}`,
        );
      }
      throw new Error(`tier-config request failed: HTTP ${response.status}`);
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch (error) {
      this.logger.error?.(
        CHANNEL,
        `Failed to parse tier config JSON: ${toErrorMessage(error)}`,
      );
      throw error;
    }

    // Parse user-specific blocks. Both are only present when the request
    // carries auth, so they resolve to null on an anonymous fetch and on parse
    // failure — a relay-side schema drift should not silently serve stale
    // values to the quota meter / BYOK switch.
    const record = data as Record<string, unknown>;
    const userStatus = this.parseOptionalBlock(
      record.userStatus,
      UserAccessStatusSchema,
      'userStatus',
    );
    const spendingStatus = this.parseOptionalBlock(
      record.spendingStatus,
      SpendingStatusSchema,
      'spendingStatus',
    );
    const spendingStatusError = this.parseOptionalBlock(
      record.spendingStatusError,
      SpendingStatusErrorSchema,
      'spendingStatusError',
    );

    const parsed = TierModelConfigSchema.safeParse(data);
    if (!parsed.success) {
      this.logger.error?.(
        CHANNEL,
        `Invalid tier config response: ${z.prettifyError(parsed.error)}`,
      );
      return { config: null, userStatus, spendingStatus, spendingStatusError };
    }

    return {
      config: parsed.data,
      userStatus,
      spendingStatus,
      spendingStatusError,
    };
  }

  /**
   * Get the tier configuration from the server.
   * Successful results are cached for 5 minutes.
   * @param authToken - Optional JWT to get user-specific access status
   */
  async getConfig(authToken?: string): Promise<TierModelConfig | null> {
    const key: TierCacheKey = authToken ? 'auth' : 'anon';
    try {
      // lru-cache dedupes concurrent fetches for the same key and serves a
      // cached value within the TTL; fetchMethod owns the snapshot updates.
      const config = await this.configCache.fetch(key, {
        context: { authToken },
      });
      return config ?? null;
    } catch {
      // fetchMethod throws on transport failure, a missing/invalid config, or a
      // post-sign-out abort; lru-cache drops the rejected entry so the next
      // call retries. fetchFromServer has already logged any genuine failure;
      // a missing config or sign-out abort is expected and stays quiet.
      return null;
    }
  }

  /**
   * Bypass the authenticated cache slot and replace the spending snapshot.
   * Clearing the old snapshot first prevents a failed refresh from presenting
   * last month's exhausted quota as current.
   */
  async refreshSpendingStatus(
    authToken?: string,
  ): Promise<TierModelConfig | null> {
    this.configCache.delete('auth');
    this.spendingStatus = null;
    this.spendingStatusError = null;
    return authToken ? this.getConfig(authToken) : null;
  }

  /**
   * Get the cached tier configuration (synchronous).
   * Returns null if config hasn't been fetched yet.
   */
  getConfigSync(): TierModelConfig | null {
    return this.configSnapshot;
  }

  /**
   * Get tier-specific config from the cached snapshot.
   * Returns null if config or tier config not available.
   */
  private getTierConfig(tier: UserTier): TierModelsConfig | null {
    return this.configSnapshot?.tiers[tier] ?? null;
  }

  /**
   * Check if a specific model is available for a user tier.
   *
   * @param tier - User's tier (free, Max, Ultra)
   * @param modelName - The model SHORT NAME to check
   */
  isModelAvailable(tier: UserTier, modelName: string): boolean {
    const tierConfig = this.getTierConfig(tier);
    if (!tierConfig) return false;
    if (tierConfig.models === '*') return true;
    return tierConfig.models.includes(modelName);
  }

  /**
   * Get the list of supported providers from the tier config.
   * All tiers have access to the same providers.
   */
  getProviders(): string[] {
    return this.configSnapshot?.providers ?? [];
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
   * Latest relay spend-check failure for the authenticated user, or null when
   * the last authenticated /tier-config fetch computed spend successfully (or
   * hasn't happened yet). Lets the UI say "the server failed to check usage"
   * instead of the generic "no usage data".
   */
  getSpendingStatusError(): SpendingStatusError | null {
    return this.spendingStatusError;
  }

  /**
   * True when the user has exhausted their monthly relay quota. Returns
   * false when status is unknown so we don't false-positive on a
   * transient network failure.
   */
  isQuotaExceeded(): boolean {
    return (
      this.spendingStatus !== null &&
      isSpendingQuotaExceeded(this.spendingStatus)
    );
  }
}
