/**
 * ServerSideKeyService - OOP service for server-side API key access.
 *
 * Encapsulates provider fetching, access determination, settings management,
 * and relay URL routing.
 *
 * RESEARCHER ACCESS PROGRAM:
 * All server-side API key access is provided as a convenience for researchers.
 * Users can always choose between server-side keys or their own API keys.
 *
 * TIER-BASED ACCESS (cumulative):
 * - Ultra tier: Access to ALL models via relay (full access)
 * - Max tier: Free-tier models plus any future Max-only additions
 * - free tier: Included non-premium models (up to $3/M input)
 */

import { toErrorMessage } from '@utils/errors/errorMessage';
import { SupabaseClient } from '../SupabaseClient';
import {
  SERVER_SIDE_CACHE_TTL_MS,
  ULTRA_TIER,
  FREE_TIER,
  type UserTier,
} from '../config';
import {
  NOOP_AUTH_SERVICE_LOGGER,
  type AuthServiceLogger,
} from '../serviceLogger';
import type { StateStore } from '@platform/interfaces';
import type { TierService } from '../tier/TierService';
import type { ServerSideProvider } from './types';

const CHANNEL = 'ServerSideKeyService';

/** Path suffixes for relay URLs, matching SDK expectations. */
const RELAY_PATH_SUFFIXES: Partial<Record<ServerSideProvider, string>> = {
  openai: '/v1',
  xai: '/v1',
  deepseek: '/v1',
  moonshot: '/v1',
  dashscope: '/compatible-mode/v1',
  minimax: '/v1',
  glm: '/api/paas/v4',
};

/** Global state key for the "use included model access" preference. */
const USE_INCLUDED_ACCESS_KEY = 'texra.useIncludedModelAccess';

export interface ClearServerSideKeyCachesOptions {
  /**
   * Reset the per-session quota auto-switch guard. Use this only when the
   * authenticated session changes, not for ordinary toggle/cache updates.
   */
  resetQuotaFlip?: boolean;
  /**
   * Keep the tier-service cache when clearing the access decision cache.
   * This preserves the spending-status explanation after a quota auto-switch.
   */
  preserveTierCache?: boolean;
  /** True when included access is being disabled by quota fallback. */
  quotaAutoSwitch?: boolean;
}

/**
 * Service for managing server-side API key access.
 *
 * USAGE PATTERN:
 * 1. Call async methods first to prime caches: canUseServerSideKeys()
 * 2. Then use sync methods for fast checks: isProviderOnServer(), canUseModelSync()
 *
 * Sync methods return false if caches aren't primed - use isCachePrimed() to check.
 */
export class ServerSideKeyService {
  // Access cache
  private accessResult = false;
  private accessTimestamp = 0;
  private accessFetchPromise: Promise<boolean> | null = null;
  private userTier: UserTier | null = null;

  // Cache state tracking
  private _isCachePrimed = false;

  /**
   * One-shot guard so the auto-flip on quota exhaustion runs at most
   * once per session. After we flip useIncludedModelAccess to false on
   * detecting an exhausted quota, the user can re-enable manually; we
   * won't fight that decision by flipping again on the next check.
   */
  private quotaFlipApplied = false;
  private quotaAutoSwitchActive = false;

  // Settings
  private useIncludedModelAccess: boolean;

  constructor(
    private readonly baseUrl: string,
    private readonly tierService: TierService,
    private readonly globalState: StateStore | null = null,
    private readonly logger: AuthServiceLogger = NOOP_AUTH_SERVICE_LOGGER,
    private readonly notifyIncludedModelAccessChanged: (
      enabled: boolean,
    ) => void = () => {},
  ) {
    this.useIncludedModelAccess =
      this.globalState?.get<boolean>(USE_INCLUDED_ACCESS_KEY, true) ?? true;
  }

  private hasFullAccess(): boolean {
    return this.userTier === ULTRA_TIER;
  }

  getUserTier(): UserTier | null {
    return this.userTier;
  }

  getUseIncludedModelAccess(): boolean {
    return this.useIncludedModelAccess;
  }

  wasQuotaAutoSwitched(): boolean {
    return this.quotaAutoSwitchActive && !this.useIncludedModelAccess;
  }

  isRelayQuotaExceeded(): boolean {
    return this.tierService.isQuotaExceeded();
  }

  async setUseIncludedModelAccess(
    value: boolean,
    cacheOptions: ClearServerSideKeyCachesOptions = {},
  ): Promise<void> {
    const changed = this.useIncludedModelAccess !== value;
    this.useIncludedModelAccess = value;
    this.quotaAutoSwitchActive =
      !value && cacheOptions.quotaAutoSwitch === true;

    if (this.globalState) {
      await this.globalState.update(USE_INCLUDED_ACCESS_KEY, value);
    }

    if (changed) {
      this.clearAllCaches(cacheOptions);
      // No pre-fetch on enable — the next canUseServerSideKeys() does
      // its own auth'd fetch in parallel with fetchAccessStatus(), and
      // an anonymous pre-fetch here would populate the 'anon' cache slot
      // rather than the 'auth' slot needed for the access check.
      try {
        this.notifyIncludedModelAccessChanged(value);
      } catch (error) {
        this.logger.error(
          CHANNEL,
          `Event listener failed: ${toErrorMessage(error)}`,
        );
      }
    }
  }

  isCachePrimed(): boolean {
    return this._isCachePrimed;
  }

  clearAllCaches(options: ClearServerSideKeyCachesOptions = {}): void {
    this._isCachePrimed = false;
    this.accessResult = false;
    this.accessTimestamp = 0;
    this.accessFetchPromise = null;
    this.userTier = null;
    if (options.resetQuotaFlip) {
      this.quotaFlipApplied = false;
      this.quotaAutoSwitchActive = false;
    }
    if (!options.preserveTierCache) this.tierService.clearCache();
  }

  isProviderOnServer(provider: string): boolean {
    return this.tierService.getProviders().includes(provider.toLowerCase());
  }

  private isAccessCacheValid(): boolean {
    return (
      this.accessFetchPromise !== null &&
      Date.now() - this.accessTimestamp < SERVER_SIDE_CACHE_TTL_MS
    );
  }

  private async fetchAccessStatus(): Promise<boolean> {
    try {
      if (!(await SupabaseClient.isAuthenticated())) {
        return this.setAccessDenied();
      }
      const tier = await SupabaseClient.getUserTier();
      this.accessResult = true;
      this.userTier = tier || FREE_TIER;
      return true;
    } catch (error) {
      // Denied by error (auth/network failure), not by policy — log so the two
      // are distinguishable. The interface exposes only info/error levels.
      this.logger.error(
        CHANNEL,
        `Access check failed, treating as denied: ${toErrorMessage(error)}`,
      );
      return this.setAccessDenied();
    }
  }

  private setAccessDenied(): false {
    this.accessResult = false;
    this.userTier = null;
    return false;
  }

  /**
   * Check if the current user can use server-side API keys.
   * Primes all caches for subsequent sync calls.
   */
  async canUseServerSideKeys(): Promise<boolean> {
    if (!this.useIncludedModelAccess) {
      this.clearAllCaches({ preserveTierCache: this.wasQuotaAutoSwitched() });
      return false;
    }

    if (
      this.isAccessCacheValid() &&
      (this.hasFullAccess() || this.tierService.getConfigSync() !== null)
    ) {
      return this.accessFetchPromise!;
    }

    this.accessFetchPromise = (async () => {
      const authToken =
        (await SupabaseClient.getRelayAccessToken()) ?? undefined;

      const [hasAccess, tierConfig] = await Promise.all([
        this.fetchAccessStatus(),
        this.tierService.getConfig(authToken),
      ]);

      if (this.tierService.isAccessExpired()) {
        this.logger.info(CHANNEL, 'User access has expired');
        this.accessResult = false;
        return false;
      }

      if (!this.hasFullAccess() && tierConfig === null) {
        this.logger.info(
          CHANNEL,
          'Tier config unavailable for non-Ultra user, denying access',
        );
        this.accessResult = false;
        return false;
      }

      const providers = this.tierService.getProviders();
      const accessGranted = hasAccess && providers.length > 0;

      if (accessGranted) {
        this.accessTimestamp = Date.now();
        this._isCachePrimed = true;
      }

      // Auto-flip useIncludedModelAccess to false when the user's
      // monthly relay quota is exhausted. The toggle change is visible
      // in Settings → Models so the user isn't surprised by silent
      // routing changes — they can flip it back if they want to retry
      // and surface the relay's 402 error directly.
      if (
        !this.quotaFlipApplied &&
        hasAccess &&
        this.tierService.isQuotaExceeded()
      ) {
        this.quotaFlipApplied = true;
        this.logger.info(
          CHANNEL,
          'Relay quota exhausted; switching useIncludedModelAccess off',
        );
        // Await so the persisted toggle state, the cleared cache, and
        // the access result agree by the time the caller resumes.
        await this.setUseIncludedModelAccess(false, {
          preserveTierCache: true,
          quotaAutoSwitch: true,
        });
        return false;
      }

      return accessGranted;
    })();

    return this.accessFetchPromise;
  }

  async canUseServerSideKeysForModel(modelName: string): Promise<boolean> {
    return (
      (await this.canUseServerSideKeys()) && this.canUseModelSync(modelName)
    );
  }

  canUseModelSync(modelName: string): boolean {
    if (!this.userTier) return false;
    if (this.hasFullAccess()) return true;
    return this.tierService.isModelAvailable(this.userTier, modelName);
  }

  shouldUseServerSideKeysSync(provider: string, modelName?: string): boolean {
    if (
      !this.useIncludedModelAccess ||
      !this.isProviderOnServer(provider) ||
      !this.accessResult
    ) {
      return false;
    }
    return modelName ? this.canUseModelSync(modelName) : this.hasFullAccess();
  }

  getAccessDescription(): string {
    if (!this.userTier) {
      return 'No included model access';
    }
    return this.tierService.getAccessDescription(this.userTier);
  }

  getAccessExpirationDate(): Date | null {
    return this.tierService.getExpirationDate();
  }

  getRelayBaseUrl(provider: string): string {
    const normalizedProvider = provider.toLowerCase() as ServerSideProvider;
    const suffix = RELAY_PATH_SUFFIXES[normalizedProvider] ?? '';
    return `${this.baseUrl}/functions/v1/relay/${normalizedProvider}${suffix}`;
  }
}
