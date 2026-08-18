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

import type { StateStore } from '@platform/interfaces';
import type { SpendingStatus, SpendingStatusError } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { SupabaseClient } from '../SupabaseClient';
import {
  SERVER_SIDE_CACHE_TTL_MS,
  ULTRA_TIER,
  FREE_TIER,
  type UserTier,
} from '../config';
import type { ModelProvider } from 'llm-zoo';
import type { TierService } from './TierService';

interface ServerSideKeyLogger {
  error(message: string, options?: { data?: unknown }): void;
  info(message: string, options?: { data?: unknown }): void;
}

/**
 * When the last access fetch was anonymous (dead session), the authenticated
 * cache gate discards it and every model-dispatch call retries the full relay
 * fetch + token-refresh attempt with no backoff — a retry storm. This short
 * backoff gates anonymous refetches so a dead-session window doesn't hammer
 * the relay and GoTrue on the model hot path.
 */
const ANONYMOUS_FETCH_BACKOFF_MS = 30_000;

/** Path suffixes for relay URLs, matching SDK expectations. */
const RELAY_PATH_SUFFIXES: Partial<Record<ModelProvider, string>> = {
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

interface AccessStatus {
  hasAccess: boolean;
  userTier: UserTier | null;
}

/**
 * Everything one completed access fetch decided. These facts commit and clear
 * as a unit: a tier without its access decision, or a decision without the
 * authentication provenance that qualifies it, is a state the cache gates read
 * wrong. `null` means no fetch has committed since the last cache clear.
 */
interface AccessSnapshot {
  /** Whether relay access was granted. */
  readonly granted: boolean;
  readonly userTier: UserTier | null;
  /**
   * Whether the fetch carried a relay auth token. An anonymous fetch (dead
   * session refresh at the time) must not satisfy a later check via the cache:
   * the tier config it produced has no user blocks, so we fall through and
   * refetch, picking up a now-valid token.
   */
  readonly authenticated: boolean;
  /**
   * When the snapshot committed, or null when the result is immediately
   * retryable (an authenticated transport or config failure) and so must never
   * satisfy a cache window.
   */
  readonly cachedAt: number | null;
}

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
 * Sync methods return false until an access fetch has committed a snapshot.
 */
export class ServerSideKeyService {
  /** The committed access decision, or null when no fetch has committed. */
  private access: AccessSnapshot | null = null;

  /**
   * The in-flight or most recently completed access fetch. Deliberately
   * outside {@link AccessSnapshot}: it is installed synchronously so
   * overlapping callers join one fetch, well before that fetch has a decision
   * to commit.
   */
  private accessFetchPromise: Promise<boolean> | null = null;

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
    private readonly logger?: ServerSideKeyLogger,
    private readonly notifyIncludedModelAccessChanged: (
      enabled: boolean,
    ) => void = () => {},
  ) {
    // Without a state store the preference can neither be read nor persisted
    // nor surfaced in any settings UI, so included (relay) access starts off
    // rather than silently routing that process's model traffic through
    // TeXRA's servers. Only a host that owns state can opt in.
    // `?? true` normalizes a hand-edited persisted `null`, which `get` casts
    // through rather than coercing; without it, access silently flips off.
    this.useIncludedModelAccess =
      this.globalState !== null &&
      (this.globalState.get<boolean>(USE_INCLUDED_ACCESS_KEY, true) ?? true);
  }

  private hasFullAccess(): boolean {
    return this.access?.userTier === ULTRA_TIER;
  }

  getUserTier(): UserTier | null {
    return this.access?.userTier ?? null;
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

  getSpendingStatus(): SpendingStatus | null {
    return this.tierService.getSpendingStatus();
  }

  getSpendingStatusError(): SpendingStatusError | null {
    return this.tierService.getSpendingStatusError();
  }

  /**
   * Refresh the relay spend snapshot without touching the access decision.
   * canUseServerSideKeys() cannot serve this: in personal mode it clears the
   * tier cache and returns early. This always bypasses the authenticated tier
   * cache so quota decisions use the current billing month.
   */
  async refreshSpendingStatus(): Promise<SpendingStatus | null> {
    const authToken = await SupabaseClient.getRelayAccessToken();
    await this.tierService.refreshSpendingStatus(authToken ?? undefined);
    return this.tierService.getSpendingStatus();
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
        this.logger?.error(`Event listener failed: ${toErrorMessage(error)}`);
      }
    }
  }

  clearAllCaches(options: ClearServerSideKeyCachesOptions = {}): void {
    // The access decision is always dropped whole. `preserveTierCache` speaks
    // only for the separately owned TierService cache, so a quota auto-switch
    // can keep its spending-status explanation after the decision is gone.
    this.access = null;
    this.accessFetchPromise = null;
    if (options.resetQuotaFlip) {
      this.quotaFlipApplied = false;
      this.quotaAutoSwitchActive = false;
    }
    if (!options.preserveTierCache) this.tierService.clearCache();
  }

  isProviderOnServer(provider: ModelProvider): boolean {
    return this.tierService.getProviders().includes(provider);
  }

  /**
   * Compute the account access status without changing cached service state.
   * The calling fetch commits this result only if it is still the most recent
   * request, so an older anonymous request cannot erase a later authenticated
   * result.
   */
  private async fetchAccessStatus(): Promise<AccessStatus> {
    try {
      if (!(await SupabaseClient.isAuthenticated())) {
        return { hasAccess: false, userTier: null };
      }
      const tier = await SupabaseClient.getUserTier();
      return { hasAccess: true, userTier: tier || FREE_TIER };
    } catch (error) {
      // Denied by error (auth/network failure), not by policy — log so the two
      // are distinguishable.
      this.logger?.error(
        `Access check failed, treating as denied: ${toErrorMessage(error)}`,
      );
      return { hasAccess: false, userTier: null };
    }
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

    const cached = this.access;
    const existingFetch = this.accessFetchPromise;

    // Authenticated cache: full TTL, plus the access/tier-config gate.
    if (
      existingFetch &&
      cached?.authenticated &&
      cached.cachedAt !== null &&
      Date.now() - cached.cachedAt < SERVER_SIDE_CACHE_TTL_MS &&
      (this.hasFullAccess() || this.tierService.getConfigSync() !== null)
    ) {
      return existingFetch;
    }

    // Anonymous-fetch backoff: when the session is dead AND access was
    // denied, every call on the model-dispatch hot path would otherwise
    // retry the full relay fetch + token-refresh attempt with no backoff.
    // A short negative-cache keeps the retry storm bounded while still
    // picking up a re-sign-in promptly.
    //
    // The backoff only applies to denied anonymous fetches. A granted
    // anonymous fetch (hasAccess && providers available) means the only
    // missing piece is the relay auth token, which may be available on the
    // next attempt — those are allowed to retry.
    if (
      existingFetch &&
      cached &&
      !cached.authenticated &&
      !cached.granted &&
      cached.cachedAt !== null &&
      Date.now() - cached.cachedAt < ANONYMOUS_FETCH_BACKOFF_MS
    ) {
      return existingFetch;
    }

    // Start the fetch and store the promise synchronously so overlapping
    // calls see it. Its completion handler compares the captured promise with
    // the current one to avoid committing metadata from a stale fetch.
    const fetchPromise = Promise.resolve().then(async () => {
      const authToken =
        (await SupabaseClient.getRelayAccessToken()) ?? undefined;
      const thisFetchAuthenticated = authToken !== undefined;

      const [accessStatus, tierConfig] = await Promise.all([
        this.fetchAccessStatus(),
        this.tierService.getConfig(authToken),
      ]);

      const hasFullAccess = accessStatus.userTier === ULTRA_TIER;
      const providers =
        tierConfig?.providers ?? this.tierService.getProviders();
      let accessGranted = accessStatus.hasAccess && providers.length > 0;

      if (this.tierService.isAccessExpired()) {
        this.logger?.info('User access has expired');
        accessGranted = false;
      } else if (!hasFullAccess && tierConfig === null) {
        this.logger?.info(
          'Tier config unavailable for non-Ultra user, denying access',
        );
        accessGranted = false;
      }

      // Commit the complete access snapshot at one boundary. A superseded
      // fetch may return its own result to its caller, but it must not alter
      // the canonical tier, access decision, or authentication metadata.
      const isLatest = this.accessFetchPromise === fetchPromise;
      if (isLatest) {
        this.access = {
          granted: accessGranted,
          userTier: accessStatus.userTier,
          authenticated: thisFetchAuthenticated,
          // Successful results use the normal TTL. Anonymous denials use the
          // intentional short backoff. An authenticated transport/config
          // failure remains immediately retryable, so it caches no timestamp.
          cachedAt:
            accessGranted || !thisFetchAuthenticated ? Date.now() : null,
        };
      }

      if (!isLatest || !accessGranted) return accessGranted;

      // Auto-flip useIncludedModelAccess to false when the user's
      // monthly relay quota is exhausted. The toggle change is visible
      // in Settings → Models so the user isn't surprised by silent
      // routing changes — they can flip it back if they want to retry
      // and surface the relay's 402 error directly.
      if (
        !this.quotaFlipApplied &&
        accessStatus.hasAccess &&
        this.tierService.isQuotaExceeded()
      ) {
        this.quotaFlipApplied = true;
        this.logger?.info(
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
    });
    this.accessFetchPromise = fetchPromise;

    return fetchPromise;
  }

  async canUseServerSideKeysForModel(modelName: string): Promise<boolean> {
    return (
      (await this.canUseServerSideKeys()) && this.canUseModelSync(modelName)
    );
  }

  canUseModelSync(modelName: string): boolean {
    const userTier = this.access?.userTier;
    if (!userTier) return false;
    if (this.hasFullAccess()) return true;
    return this.tierService.isModelAvailable(userTier, modelName);
  }

  shouldUseServerSideKeysSync(
    provider: ModelProvider,
    modelName?: string,
  ): boolean {
    if (
      !this.useIncludedModelAccess ||
      !this.isProviderOnServer(provider) ||
      this.access?.granted !== true
    ) {
      return false;
    }
    return modelName ? this.canUseModelSync(modelName) : this.hasFullAccess();
  }

  getRelayBaseUrl(provider: ModelProvider): string {
    const suffix = RELAY_PATH_SUFFIXES[provider] ?? '';
    return `${this.baseUrl}/functions/v1/relay/${provider}${suffix}`;
  }
}
