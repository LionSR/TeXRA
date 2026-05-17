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
 * - Max tier: Mid-tier models ($1-3/M) + all free tier models
 * - free tier: Budget models only (under $1/M input)
 */

import { EventEmitter } from 'events';
import {
  SERVER_SIDE_CACHE_TTL_MS,
  ULTRA_TIER,
  FREE_TIER,
  type UserTier,
} from '../sharedConfig';
import {
  NOOP_AUTH_SERVICE_LOGGER,
  type AuthServiceLogger,
} from '../serviceLogger';
import type { StateStore } from '@platform/interfaces/state';
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

const SERVICE_EVENT = 'event';

/**
 * Interface for authentication provider that can check auth state and get user tier.
 */
export interface AuthProvider {
  isAuthenticated(): Promise<boolean>;
  getUserTier(): Promise<UserTier>;
  getAccessToken(): Promise<string | null>;
}

export interface ServerSideKeyDisposable {
  dispose(): void;
}

export type ServerSideKeyEvent<T> = (
  listener: (event: T) => unknown,
  thisArgs?: unknown,
  disposables?: ServerSideKeyDisposable[],
) => ServerSideKeyDisposable;

export type ServerSideKeyState = StateStore;

export interface ServerSideKeyServiceInit {
  state?: ServerSideKeyState;
  subscriptions?: ServerSideKeyDisposable[];
  logger?: AuthServiceLogger;
}

export interface ClearServerSideKeyCachesOptions {
  /**
   * Reset the per-session quota auto-switch guard. Use this only when the
   * authenticated session changes, not for ordinary toggle/cache updates.
   */
  resetQuotaFlip?: boolean;
}

class NodeEventEmitter<T> implements ServerSideKeyDisposable {
  private readonly emitter = new EventEmitter();

  constructor(private readonly logger: AuthServiceLogger) {}

  readonly event: ServerSideKeyEvent<T> = (listener, thisArgs, disposables) => {
    const boundListener =
      thisArgs === undefined ? listener : listener.bind(thisArgs);
    this.emitter.on(SERVICE_EVENT, boundListener);
    const disposable = {
      dispose: () => this.emitter.off(SERVICE_EVENT, boundListener),
    };
    disposables?.push(disposable);
    return disposable;
  };

  fire(event: T): void {
    for (const listener of this.emitter.listeners(SERVICE_EVENT)) {
      try {
        listener(event);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(CHANNEL, `Event listener failed: ${message}`);
      }
    }
  }

  dispose(): void {
    this.emitter.removeAllListeners();
  }
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

  // Settings
  private useIncludedModelAccess = true;
  private globalState: ServerSideKeyState | null = null;
  private readonly _onDidChangeModelAccess: NodeEventEmitter<boolean>;
  private readonly _onCacheCleared: NodeEventEmitter<void>;
  private readonly _tierServiceClearSubscription: ServerSideKeyDisposable;

  readonly onDidChangeModelAccess: ServerSideKeyEvent<boolean>;
  readonly onCacheCleared: ServerSideKeyEvent<void>;

  constructor(
    private readonly baseUrl: string,
    private readonly authProvider: AuthProvider,
    private readonly tierService: TierService,
    private readonly logger: AuthServiceLogger = NOOP_AUTH_SERVICE_LOGGER,
  ) {
    this._onDidChangeModelAccess = new NodeEventEmitter<boolean>(this.logger);
    this._onCacheCleared = new NodeEventEmitter<void>(this.logger);
    this.onDidChangeModelAccess = this._onDidChangeModelAccess.event;
    this.onCacheCleared = this._onCacheCleared.event;
    this._tierServiceClearSubscription = this._onCacheCleared.event(() => {
      this.tierService.clearCache();
    });
  }

  /**
   * Initialize the service with host-provided state and subscriptions.
   * This enables settings persistence without coupling the service to VS Code.
   */
  initialize(options: ServerSideKeyServiceInit): void {
    options.subscriptions?.push(
      this._onDidChangeModelAccess,
      this._onCacheCleared,
      this._tierServiceClearSubscription,
    );
    this.globalState = options.state ?? null;
    this.useIncludedModelAccess =
      this.globalState?.get<boolean>(USE_INCLUDED_ACCESS_KEY, true) ?? true;
  }

  dispose(): void {
    this._onDidChangeModelAccess.dispose();
    this._onCacheCleared.dispose();
    this._tierServiceClearSubscription.dispose();
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
    return this.quotaFlipApplied && !this.useIncludedModelAccess;
  }

  async setUseIncludedModelAccess(value: boolean): Promise<void> {
    const changed = this.useIncludedModelAccess !== value;
    this.useIncludedModelAccess = value;

    if (this.globalState) {
      await this.globalState.update(USE_INCLUDED_ACCESS_KEY, value);
    }

    if (changed) {
      this.clearAllCaches();

      // Pre-fetch tier config (which includes providers) when enabling
      if (value) {
        await this.tierService.getConfig();
      }

      this._onDidChangeModelAccess.fire(value);
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
    if (options.resetQuotaFlip === true) {
      this.quotaFlipApplied = false;
    }
    this._onCacheCleared.fire(undefined);
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
      if (!(await this.authProvider.isAuthenticated())) {
        return this.setAccessDenied();
      }
      const tier = await this.authProvider.getUserTier();
      this.accessResult = true;
      this.userTier = tier || FREE_TIER;
      return true;
    } catch {
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
    if (!this.getUseIncludedModelAccess()) {
      this.clearAllCaches();
      return false;
    }

    if (
      this.isAccessCacheValid() &&
      (this.hasFullAccess() || this.tierService.getConfigSync() !== null)
    ) {
      return this.accessFetchPromise!;
    }

    this.accessFetchPromise = (async () => {
      const authToken = (await this.authProvider.getAccessToken()) ?? undefined;

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

      if (hasAccess && providers.length > 0) {
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
        // Fire-and-forget — we don't want to block the access check on
        // state persistence. setUseIncludedModelAccess clears caches as
        // a side-effect so the toggle change takes effect immediately.
        void this.setUseIncludedModelAccess(false);
        return false;
      }

      return hasAccess && providers.length > 0;
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
      !this.getUseIncludedModelAccess() ||
      !this.isProviderOnServer(provider.toLowerCase()) ||
      !this.accessResult
    ) {
      return false;
    }
    return modelName ? this.canUseModelSync(modelName) : this.hasFullAccess();
  }

  /** Returns null if all models allowed (Ultra), empty array if no access. */
  getAllowedModelsForCurrentUser(): string[] | null {
    if (!this.userTier) return [];
    if (this.hasFullAccess()) return null;
    return this.tierService.getAllowedModels(this.userTier);
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
