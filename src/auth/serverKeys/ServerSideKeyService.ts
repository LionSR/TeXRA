/**
 * ServerSideKeyService - OOP service for server-side API key access.
 *
 * Encapsulates provider fetching, access determination, settings management,
 * and relay URL routing. This replaces the module-level functions with a
 * proper class that can be tested and injected.
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

const LOG_PREFIX = '[ServerSideKeyService]';

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
}

/**
 * Service for managing server-side API key access.
 */
export class ServerSideKeyService {
  // Providers cache
  private providers: string[] = [];
  private providersTimestamp = 0;
  private providersFetchPromise: Promise<string[]> | null = null;

  // Access cache
  private accessResult = false;
  private accessTimestamp = 0;
  private accessFetchPromise: Promise<boolean> | null = null;
  private userTier: UserTier | null = null;

  // Settings
  private useIncludedModelAccess = true;
  private globalState: vscode.Memento | null = null;
  private readonly _onDidChangeModelAccess = new vscode.EventEmitter<boolean>();

  /**
   * Event that fires when the "use included model access" setting changes.
   */
  readonly onDidChangeModelAccess = this._onDidChangeModelAccess.event;

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
  ) {}

  /**
   * Initialize the service with VS Code extension context.
   * This enables settings persistence.
   */
  initialize(context: vscode.ExtensionContext): void {
    context.subscriptions.push(this._onDidChangeModelAccess);
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

      // Pre-fetch data when enabling
      if (value) {
        await Promise.all([
          this.getEnabledProviders(),
          this.tierService.getConfig(),
        ]);
      }

      this._onDidChangeModelAccess.fire(value);
    }
  }

  // ==========================================================================
  // Cache Management
  // ==========================================================================

  /**
   * Clear all caches.
   * Call this when user signs in/out.
   */
  clearAllCaches(): void {
    this.accessResult = false;
    this.accessTimestamp = 0;
    this.accessFetchPromise = null;
    this.userTier = null;
    this.providers = [];
    this.providersTimestamp = 0;
    this.providersFetchPromise = null;
    this.tierService.clearCache();
  }

  /**
   * Get the cached user tier (synchronous).
   */
  getCachedUserTier(): UserTier | null {
    return this.userTier;
  }

  /**
   * Get the cached providers list (synchronous).
   */
  getCachedProviders(): string[] {
    return this.providers;
  }

  // ==========================================================================
  // Provider Fetching
  // ==========================================================================

  private isProvidersCacheValid(): boolean {
    return (
      this.providersFetchPromise !== null &&
      Date.now() - this.providersTimestamp < SERVER_SIDE_CACHE_TTL_MS
    );
  }

  private async fetchProvidersFromServer(): Promise<string[]> {
    try {
      const url = `${this.baseUrl}/functions/v1/relay/providers`;
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) {
        console.error(
          `${LOG_PREFIX} Failed to fetch providers: ${response.status}`,
        );
        return [];
      }

      const data = await response.json();
      if (Array.isArray(data.providers)) {
        this.providers = data.providers;
        return data.providers;
      }

      return [];
    } catch (error) {
      console.error(`${LOG_PREFIX} Error fetching providers:`, error);
      return [];
    }
  }

  /**
   * Get the list of enabled providers from the relay server.
   */
  async getEnabledProviders(): Promise<string[]> {
    if (this.isProvidersCacheValid()) {
      return this.providersFetchPromise!;
    }

    this.providersTimestamp = Date.now();
    this.providersFetchPromise = this.fetchProvidersFromServer();
    return this.providersFetchPromise;
  }

  /**
   * Get the cached list of enabled providers (synchronous).
   */
  getEnabledProvidersSync(): string[] {
    return this.providers;
  }

  /**
   * Check if a provider is enabled on the server.
   */
  isProviderEnabled(provider: string): boolean {
    return this.providers.includes(provider.toLowerCase());
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

    const tierConfigAvailable =
      this.userTier === ULTRA_TIER || this.tierService.getConfigSync() !== null;

    if (this.isAccessCacheValid() && tierConfigAvailable) {
      return this.accessFetchPromise!;
    }

    this.accessFetchPromise = (async () => {
      const [hasAccess, providers, tierConfig] = await Promise.all([
        this.fetchAccessStatus(),
        this.getEnabledProviders(),
        this.tierService.getConfig(),
      ]);

      const tierConfigRequired =
        this.userTier !== ULTRA_TIER && tierConfig === null;
      if (hasAccess && providers.length > 0 && !tierConfigRequired) {
        this.accessTimestamp = Date.now();
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

    return this.isModelAvailableForCurrentTierSync(modelName);
  }

  /**
   * Synchronous check if a model is available for the current user's tier.
   */
  isModelAvailableForCurrentTierSync(modelName: string): boolean {
    if (!this.userTier) {
      return false;
    }

    if (this.userTier === ULTRA_TIER) {
      return true;
    }

    return this.tierService.isModelAvailable(this.userTier, modelName);
  }

  /**
   * Synchronous check if server-side keys should be used for routing.
   *
   * IMPORTANT: This only returns true if:
   * 1. The setting is enabled
   * 2. The provider is enabled on the server
   * 3. A previous async check confirmed access
   * 4. For non-Ultra tier: the model must be in the tier's allowed list
   */
  shouldUseServerSideKeysSync(provider: string, modelName?: string): boolean {
    if (!this.isEnabled()) {
      return false;
    }

    const normalizedProvider = provider.toLowerCase();
    if (!this.providers.includes(normalizedProvider)) {
      return false;
    }

    if (this.accessResult !== true) {
      return false;
    }

    if (this.userTier === ULTRA_TIER) {
      return true;
    }

    if (!this.userTier || !modelName) {
      return false;
    }

    if (!this.tierService.isProviderAvailable(this.userTier, normalizedProvider)) {
      return false;
    }

    return this.tierService.isModelAvailable(this.userTier, modelName);
  }

  /**
   * Check if a provider is available for the current user's tier.
   */
  isProviderAvailableForCurrentTier(provider: string): boolean {
    const normalizedProvider = provider.toLowerCase();

    if (!this.providers.includes(normalizedProvider)) {
      return false;
    }

    if (this.userTier === ULTRA_TIER) {
      return true;
    }

    if (!this.userTier) {
      return false;
    }

    return this.tierService.isProviderAvailable(this.userTier, normalizedProvider);
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
