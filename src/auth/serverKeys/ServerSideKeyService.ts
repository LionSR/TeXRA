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

import * as vscode from 'vscode';
import {
  SERVER_SIDE_CACHE_TTL_MS,
  ULTRA_TIER,
  FREE_TIER,
  type UserTier,
} from '../config';
import type { TierService } from '../tier/TierService';
import type { ServerSideProvider } from './types';
import * as logger from '@logger/logUtils';

const CHANNEL = 'ServerSideKeyService';

/** Path suffixes for relay URLs, matching SDK expectations. */
const RELAY_PATH_SUFFIXES: Partial<Record<ServerSideProvider, string>> = {
  openai: '/v1',
  xai: '/v1',
  moonshot: '/v1',
  dashscope: '/compatible-mode/v1',
};

/** Global state key for the "use included model access" preference. */
const USE_INCLUDED_ACCESS_KEY = 'texra.useIncludedModelAccess';

/**
 * Interface for authentication provider that can check auth state and get user tier.
 */
export interface AuthProvider {
  isAuthenticated(): Promise<boolean>;
  getUserTier(): Promise<UserTier>;
  getAccessToken(): Promise<string | null>;
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

  // Settings
  private useIncludedModelAccess = true;
  private globalState: vscode.Memento | null = null;
  private readonly _onDidChangeModelAccess = new vscode.EventEmitter<boolean>();
  private readonly _onCacheCleared = new vscode.EventEmitter<void>();
  private readonly _tierServiceClearSubscription: vscode.Disposable;

  /**
   * Event that fires when the "use included model access" setting changes.
   */
  readonly onDidChangeModelAccess = this._onDidChangeModelAccess.event;

  /**
   * Event that fires when caches are cleared.
   * TierService listens to this to clear its own cache.
   */
  readonly onCacheCleared = this._onCacheCleared.event;

  /**
   * Create a new ServerSideKeyService.
   *
   * @param baseUrl - The base URL for the relay server
   * @param authProvider - Provider for authentication state checks
   * @param tierService - Service for tier configuration
   */
  constructor(
    private readonly baseUrl: string,
    private readonly authProvider: AuthProvider,
    private readonly tierService: TierService,
  ) {
    // TierService clears its own cache when we fire the event
    // Store subscription to dispose later (prevents memory leak)
    this._tierServiceClearSubscription = this._onCacheCleared.event(() => {
      this.tierService.clearCache();
    });
  }

  /**
   * Initialize the service with VS Code extension context.
   * This enables settings persistence.
   */
  initialize(context: vscode.ExtensionContext): void {
    context.subscriptions.push(this._onDidChangeModelAccess);
    context.subscriptions.push(this._onCacheCleared);
    context.subscriptions.push(this._tierServiceClearSubscription);
    this.globalState = context.globalState;
    this.useIncludedModelAccess = this.globalState.get<boolean>(
      USE_INCLUDED_ACCESS_KEY,
      true,
    );
  }

  /**
   * Dispose resources.
   */
  dispose(): void {
    this._onDidChangeModelAccess.dispose();
    this._onCacheCleared.dispose();
    this._tierServiceClearSubscription.dispose();
  }

  // ==========================================================================
  // Tier Helpers (eliminates duplicated Ultra checks)
  // ==========================================================================

  /**
   * Check if the current user has full access (Ultra tier).
   * Ultra tier users can access all models without restrictions.
   */
  private hasFullAccess(): boolean {
    return this.userTier === ULTRA_TIER;
  }

  /**
   * Get the current user's tier. Returns null if not authenticated/cached.
   */
  getUserTier(): UserTier | null {
    return this.userTier;
  }

  // ==========================================================================
  // Settings
  // ==========================================================================

  /**
   * Check if the "use included model access" setting is enabled.
   */
  isEnabled(): boolean {
    return this.useIncludedModelAccess;
  }

  /**
   * Get the current "use included model access" preference.
   */
  getUseIncludedModelAccess(): boolean {
    return this.useIncludedModelAccess;
  }

  /**
   * Set the "use included model access" preference.
   * When enabling, pre-fetches providers and tier config.
   */
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

  // ==========================================================================
  // Cache Management
  // ==========================================================================

  /**
   * Check if caches have been primed by an async call.
   * Sync methods return false if not primed.
   */
  isCachePrimed(): boolean {
    return this._isCachePrimed;
  }

  /**
   * Clear all caches.
   * Call this when user signs in/out.
   * Fires onCacheCleared event so TierService can clear its cache too.
   */
  clearAllCaches(): void {
    this._isCachePrimed = false;
    this.accessResult = false;
    this.accessTimestamp = 0;
    this.accessFetchPromise = null;
    this.userTier = null;
    // Fire event so TierService clears its own cache (which includes providers)
    this._onCacheCleared.fire();
  }

  // ==========================================================================
  // Provider Access (delegates to TierService)
  // ==========================================================================

  /**
   * Get the cached list of enabled providers (synchronous).
   * Returns empty array if tier config not fetched yet.
   * Call canUseServerSideKeys() first to prime the cache.
   */
  getEnabledProvidersSync(): string[] {
    return this.tierService.getProviders();
  }

  /**
   * Check if a provider has API keys configured on the server.
   * All tiers have access to the same providers.
   */
  isProviderOnServer(provider: string): boolean {
    return this.tierService.getProviders().includes(provider.toLowerCase());
  }

  // ==========================================================================
  // Access Determination
  // ==========================================================================

  private isAccessCacheValid(): boolean {
    return (
      this.accessFetchPromise !== null &&
      Date.now() - this.accessTimestamp < SERVER_SIDE_CACHE_TTL_MS
    );
  }

  private async fetchAccessStatus(): Promise<boolean> {
    try {
      const isAuthenticated = await this.authProvider.isAuthenticated();
      if (!isAuthenticated) {
        this.accessResult = false;
        this.userTier = null;
        return false;
      }

      const tier = await this.authProvider.getUserTier();
      this.accessResult = true;
      this.userTier = tier || FREE_TIER;
      return true;
    } catch (_err) {
      this.accessResult = false;
      this.userTier = null;
      return false;
    }
  }

  /**
   * Check if the current user can use server-side API keys.
   * This primes all caches for subsequent sync calls.
   *
   * Requirements:
   * 1. The setting must be enabled
   * 2. User must be authenticated
   * 3. At least one provider must be enabled on the server
   */
  async canUseServerSideKeys(): Promise<boolean> {
    if (!this.isEnabled()) {
      this.clearAllCaches();
      return false;
    }

    // Check if tier config is already cached (sync check).
    // Ultra tier doesn't need tier config, so it's always "available".
    // If cache miss, the async fetch below will populate it.
    const tierConfigAvailable =
      this.hasFullAccess() || this.tierService.getConfigSync() !== null;

    if (this.isAccessCacheValid() && tierConfigAvailable) {
      return this.accessFetchPromise!;
    }

    this.accessFetchPromise = (async () => {
      // Get auth token for tier-config request (to get expiration status)
      const authToken = (await this.authProvider.getAccessToken()) ?? undefined;

      // Fetch auth status and tier config (which includes providers)
      const [hasAccess, tierConfig] = await Promise.all([
        this.fetchAccessStatus(),
        this.tierService.getConfig(authToken),
      ]);

      // Check if access has expired
      if (this.tierService.isAccessExpired()) {
        logger.info(CHANNEL, 'User access has expired');
        this.accessResult = false;
        return false;
      }

      // Max/free users need tier config to know allowed models
      // If tier config failed, report no access so UI shows API key banner
      const tierConfigRequired = !this.hasFullAccess();
      if (tierConfigRequired && tierConfig === null) {
        logger.info(
          CHANNEL,
          'Tier config unavailable for non-Ultra user, denying access',
        );
        this.accessResult = false;
        return false;
      }

      // Get providers from tier config (now includes only enabled providers)
      const providers = this.tierService.getProviders();

      if (hasAccess && providers.length > 0) {
        this.accessTimestamp = Date.now();
        this._isCachePrimed = true;
      }

      return hasAccess && providers.length > 0;
    })();

    return this.accessFetchPromise;
  }

  /**
   * Check if a specific model is available via server-side keys.
   */
  async canUseServerSideKeysForModel(modelName: string): Promise<boolean> {
    const hasAccess = await this.canUseServerSideKeys();
    if (!hasAccess) {
      return false;
    }

    return this.canUseModelSync(modelName);
  }

  /**
   * Synchronous check if a model is available for the current user's tier.
   * Returns false if caches aren't primed - call canUseServerSideKeys() first.
   */
  canUseModelSync(modelName: string): boolean {
    if (!this.userTier) {
      return false;
    }

    // Ultra tier has full access to all models
    if (this.hasFullAccess()) {
      return true;
    }

    return this.tierService.isModelAvailable(this.userTier, modelName);
  }

  /**
   * Synchronous check if server-side keys should be used for routing.
   * Returns false if caches aren't primed - call canUseServerSideKeys() first.
   *
   * IMPORTANT: This only returns true if:
   * 1. The setting is enabled
   * 2. The provider has keys on the server
   * 3. A previous async check confirmed access
   * 4. For non-Ultra tier: the model must be in the tier's allowed list
   */
  shouldUseServerSideKeysSync(provider: string, modelName?: string): boolean {
    if (!this.isEnabled()) {
      return false;
    }

    if (!this.isProviderOnServer(provider.toLowerCase())) {
      return false;
    }

    if (this.accessResult !== true) {
      return false;
    }

    // Ultra tier has full access
    if (this.hasFullAccess()) {
      return true;
    }

    if (!this.userTier || !modelName) {
      return false;
    }

    // Check model is allowed for user's tier
    return this.tierService.isModelAvailable(this.userTier, modelName);
  }

  // ==========================================================================
  // High-Level Access Methods (for UI consumers)
  // ==========================================================================

  /**
   * Get the list of allowed models for the current user's tier.
   * Returns null if all models are allowed (Ultra), empty array if no access.
   * Call canUseServerSideKeys() first to prime caches.
   */
  getAllowedModelsForCurrentUser(): string[] | null {
    if (!this.userTier) {
      return [];
    }

    // Ultra tier has access to all models
    if (this.hasFullAccess()) {
      return null;
    }

    return this.tierService.getAllowedModels(this.userTier);
  }

  /**
   * Get the providers available for the current user.
   * Returns providers enabled on the server.
   * Call canUseServerSideKeys() first to prime caches.
   */
  getEffectiveProvidersForCurrentUser(): string[] {
    return this.tierService.getProviders();
  }

  /**
   * Get a user-friendly description of what's included for the current user's tier.
   * Call canUseServerSideKeys() first to prime caches.
   */
  getAccessDescription(): string {
    if (!this.userTier) {
      return 'No included model access';
    }

    return this.tierService.getAccessDescription(this.userTier);
  }

  /**
   * Get the expiration date for the current user's access.
   * Returns null if no expiration (lifetime access) or status not available.
   * Call canUseServerSideKeys() first to prime caches.
   */
  getAccessExpirationDate(): Date | null {
    return this.tierService.getExpirationDate();
  }

  // ==========================================================================
  // Routing
  // ==========================================================================

  /**
   * Get the relay Edge Function base URL for a specific provider.
   */
  getRelayBaseUrl(provider: string): string {
    const normalizedProvider = provider.toLowerCase() as ServerSideProvider;
    const suffix = RELAY_PATH_SUFFIXES[normalizedProvider] ?? '';
    return `${this.baseUrl}/functions/v1/relay/${normalizedProvider}${suffix}`;
  }
}
