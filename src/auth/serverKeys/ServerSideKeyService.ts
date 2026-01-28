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
import * as logger from '@logger/logUtils';
import {
  SERVER_SIDE_CACHE_TTL_MS,
  ULTRA_TIER,
  FREE_TIER,
  type UserTier,
} from '../config';
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

  readonly onDidChangeModelAccess = this._onDidChangeModelAccess.event;
  readonly onCacheCleared = this._onCacheCleared.event;

  constructor(
    private readonly baseUrl: string,
    private readonly authProvider: AuthProvider,
    private readonly tierService: TierService,
  ) {
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

  clearAllCaches(): void {
    this._isCachePrimed = false;
    this.accessResult = false;
    this.accessTimestamp = 0;
    this.accessFetchPromise = null;
    this.userTier = null;
    this._onCacheCleared.fire();
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

    const tierConfigAvailable =
      this.hasFullAccess() || this.tierService.getConfigSync() !== null;

    if (this.isAccessCacheValid() && tierConfigAvailable) {
      return this.accessFetchPromise!;
    }

    this.accessFetchPromise = (async () => {
      const authToken = (await this.authProvider.getAccessToken()) ?? undefined;

      const [hasAccess, tierConfig] = await Promise.all([
        this.fetchAccessStatus(),
        this.tierService.getConfig(authToken),
      ]);

      if (this.tierService.isAccessExpired()) {
        logger.info(CHANNEL, 'User access has expired');
        this.accessResult = false;
        return false;
      }

      if (!this.hasFullAccess() && tierConfig === null) {
        logger.info(
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
    if (!this.userTier) {
      return false;
    }
    if (this.hasFullAccess()) {
      return true;
    }
    return this.tierService.isModelAvailable(this.userTier, modelName);
  }

  shouldUseServerSideKeysSync(provider: string, modelName?: string): boolean {
    const settingEnabled = this.getUseIncludedModelAccess();
    const providerAvailable = this.isProviderOnServer(provider.toLowerCase());
    const hasAccess = this.accessResult === true;

    if (!settingEnabled || !providerAvailable || !hasAccess) {
      return false;
    }

    return modelName ? this.canUseModelSync(modelName) : this.hasFullAccess();
  }

  /** Returns null if all models allowed (Ultra), empty array if no access. */
  getAllowedModelsForCurrentUser(): string[] | null {
    if (!this.userTier) {
      return [];
    }
    if (this.hasFullAccess()) {
      return null;
    }
    return this.tierService.getAllowedModels(this.userTier);
  }

  getEffectiveProvidersForCurrentUser(): string[] {
    return this.tierService.getProviders();
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
