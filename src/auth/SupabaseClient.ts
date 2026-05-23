import {
  createClient,
  SupabaseClient as Client,
  User,
} from '@supabase/supabase-js';
import { toErrorMessage } from '@common/errors/errorMessage';
import * as logger from '@logger/logUtils';
import {
  type UserAuthContext,
  type UserTier,
  UserAuthContextSchema,
  TOKEN_REFRESH_THRESHOLD_MS,
} from './config';
import type { AuthTokenProvider, SessionTokens } from './TokenProvider';

/**
 * Singleton Supabase client with authentication helpers.
 * This is the single source of truth for auth initialization state.
 */
export class SupabaseClient {
  private static instance: Client | null = null;
  private static config: { url: string; publicKey: string } | null = null;
  private static authProvider: AuthTokenProvider | null = null;

  /**
   * Error that occurred during initialization, if any.
   * Used to provide meaningful error messages to users.
   */
  private static initError: Error | null = null;
  private static readinessError: Error | null = null;

  /**
   * Cached token expiry time (ms since epoch).
   * Updated by SupabaseAuthProvider whenever a session is stored or loaded.
   * Used for fast, synchronous expiry checks before each relay call.
   */
  private static tokenExpiresAt: number | null = null;

  /**
   * Register an auth provider for token refresh.
   * Called by SupabaseAuthProvider on initialization.
   */
  static setAuthProvider(provider: AuthTokenProvider): void {
    this.authProvider = provider;
  }

  /** Reset singleton state between unit tests. */
  static resetForTests(): void {
    this.instance = null;
    this.config = null;
    this.authProvider = null;
    this.initError = null;
    this.readinessError = null;
    this.tokenExpiresAt = null;
  }

  /**
   * Record an initialization error for later retrieval.
   * Allows surfacing meaningful error messages to users.
   */
  static setInitError(error: Error): void {
    this.initError = error;
  }

  /**
   * Get initialization error if any occurred.
   */
  static getInitError(): Error | null {
    return this.initError ?? this.readinessError;
  }

  /**
   * Update the cached token expiry time, or clear it on sign-out.
   * Called by SupabaseAuthProvider when a session is stored, loaded, or removed.
   */
  static setTokenExpiry(expiresAt: number | null): void {
    this.tokenExpiresAt = expiresAt;
  }

  /**
   * Check if the current token will expire within {@link TOKEN_REFRESH_THRESHOLD_MS}.
   * Synchronous and in-memory — safe to call before every model invocation.
   * Returns false if no expiry is tracked (e.g., not authenticated or not using relay).
   */
  static isTokenExpiringSoon(): boolean {
    if (this.tokenExpiresAt === null) {
      return false;
    }
    return this.tokenExpiresAt - Date.now() < TOKEN_REFRESH_THRESHOLD_MS;
  }

  /**
   * Check if auth system is fully initialized and ready for use.
   */
  static async isReady(): Promise<boolean> {
    if (this.instance === null || this.authProvider === null) {
      return false;
    }
    if (this.initError !== null) {
      return false;
    }

    try {
      await this.authProvider.whenReady();
      this.readinessError = null;
      return true;
    } catch (error) {
      this.readinessError =
        error instanceof Error ? error : new Error(toErrorMessage(error));
      logger.error(
        'SupabaseClient',
        `Auth provider not ready: ${toErrorMessage(error)}`,
      );
      return false;
    }
  }

  /**
   * Initialize the Supabase client with project credentials.
   */
  static initialize(url: string, publicKey: string, _context?: unknown): void {
    if (!url || !publicKey) {
      throw new Error(
        'Supabase credentials missing. Check extension configuration.',
      );
    }
    this.config = { url, publicKey };
    this.instance = createClient(url, publicKey, {
      auth: {
        persistSession: false, // VS Code manages session storage
        autoRefreshToken: false, // Manual refresh via auth provider
      },
    });
  }

  /**
   * Get the Supabase client instance.
   */
  static getClient(): Client {
    if (!this.instance) {
      throw new Error(
        'Supabase client not initialized. Restart the extension.',
      );
    }
    return this.instance;
  }

  /**
   * Get the current user's access token.
   * Returns null if not authenticated or auth system not ready.
   * @param forceRefresh - When true, forces a token refresh (e.g., after relay 401).
   */
  static async getAccessToken(forceRefresh?: boolean): Promise<string | null> {
    if (!this.authProvider) {
      // Auth provider not set - system not initialized
      return null;
    }

    try {
      return await this.authProvider.ensureFreshToken(forceRefresh);
    } catch (error) {
      logger.error(
        'SupabaseClient',
        `Error getting access token: ${toErrorMessage(error)}`,
      );
      return null;
    }
  }

  /**
   * Get access and refresh tokens from secure storage.
   * Ensures tokens are fresh before returning.
   */
  static async getSessionTokens(): Promise<SessionTokens | null> {
    if (!this.authProvider) {
      return null;
    }

    try {
      return await this.authProvider.getSessionTokens();
    } catch (error) {
      logger.error(
        'SupabaseClient',
        `Error getting session tokens: ${toErrorMessage(error)}`,
      );
      return null;
    }
  }

  /**
   * Get the current authenticated user.
   */
  static async getUser(): Promise<User | null> {
    const token = await this.getAccessToken();
    if (!token) return null;

    try {
      const { data, error } = await this.getClient().auth.getUser(token);
      if (error || !data.user) return null;
      return data.user;
    } catch (error) {
      logger.error(
        'SupabaseClient',
        `Error getting user: ${toErrorMessage(error)}`,
      );
      return null;
    }
  }

  /**
   * Get user tier from the database.
   * Returns the actual tier value: 'free', 'Max', or 'Ultra'.
   */
  static async getUserTier(): Promise<UserTier> {
    const authContext = await this.getUserAuthContext();
    return authContext.tier;
  }

  /**
   * Get the user's authorization context including permissions.
   * Permissions are visibility values the user can access.
   * Tier is reserved for future API key access levels.
   */
  static async getUserAuthContext(): Promise<UserAuthContext> {
    const defaultContext: UserAuthContext = { permissions: [], tier: 'free' };

    const tokens = await this.getSessionTokens();
    if (!tokens) return defaultContext;

    try {
      const client = this.getClient();
      await client.auth.setSession({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
      });

      // Fetch tier and permissions from profiles
      const { data, error } = await client
        .from('profiles')
        .select('tier, permissions')
        .single();

      if (error || !data) {
        logger.error(
          'SupabaseClient',
          `Error fetching profile: ${error?.message || 'No data'}`,
        );
        return defaultContext;
      }

      // Parse with Zod schema - field-level .catch() preserves valid fields
      return UserAuthContextSchema.parse(data);
    } catch (error) {
      logger.error(
        'SupabaseClient',
        `Error getting user auth context: ${toErrorMessage(error)}`,
      );
      return defaultContext;
    }
  }

  /**
   * Get user's permissions as a flat array.
   */
  static async getUserPermissions(): Promise<string[]> {
    const context = await this.getUserAuthContext();
    return context.permissions;
  }

  /**
   * Check if user is authenticated.
   */
  static async isAuthenticated(): Promise<boolean> {
    const token = await this.getAccessToken();
    return token !== null;
  }

  /** Get configuration for re-initialization. */
  static getConfig(): { url: string; publicKey: string } | null {
    return this.config;
  }
}
