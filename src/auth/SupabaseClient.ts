import {
  createClient,
  SupabaseClient as Client,
  User,
} from '@supabase/supabase-js';
import * as vscode from 'vscode';
import { toErrorMessage } from '@common/errors/errorHandlingUtils';
import * as logger from '@logger/logUtils';
import {
  type UserAuthContext,
  type UserTier,
  UserAuthContextSchema,
  SUPABASE_SESSION_KEY,
} from './config';

/** Interface for auth provider to avoid circular imports. */
interface AuthTokenProvider {
  ensureFreshToken(forceRefresh?: boolean): Promise<string | null>;
}

/**
 * Singleton Supabase client with authentication helpers.
 * This is the single source of truth for auth initialization state.
 */
export class SupabaseClient {
  private static instance: Client | null = null;
  private static config: { url: string; publicKey: string } | null = null;
  private static context: vscode.ExtensionContext | null = null;
  private static authProvider: AuthTokenProvider | null = null;

  /**
   * Whether VS Code's auth provider registration succeeded.
   * This is separate from authProvider being set (which happens in constructor).
   */
  private static vscodeProviderRegistered = false;

  /**
   * Error that occurred during initialization, if any.
   * Used to provide meaningful error messages to users.
   */
  private static initError: Error | null = null;

  /**
   * Register an auth provider for token refresh.
   * Called by SupabaseAuthProvider on initialization.
   */
  static setAuthProvider(provider: AuthTokenProvider): void {
    this.authProvider = provider;
  }

  /**
   * Mark VS Code auth provider as successfully registered.
   * Called after vscode.authentication.registerAuthenticationProvider() succeeds.
   */
  static setVSCodeProviderRegistered(): void {
    this.vscodeProviderRegistered = true;
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
    return this.initError;
  }

  /**
   * Check if auth system is fully initialized and ready for use.
   */
  static isReady(): boolean {
    return (
      this.instance !== null &&
      this.authProvider !== null &&
      this.vscodeProviderRegistered &&
      this.initError === null
    );
  }

  /**
   * Initialize the Supabase client with project credentials.
   */
  static initialize(
    url: string,
    publicKey: string,
    context?: vscode.ExtensionContext,
  ): void {
    if (!url || !publicKey) {
      throw new Error(
        'Supabase credentials missing. Check extension configuration.',
      );
    }
    this.config = { url, publicKey };
    if (context) {
      this.context = context;
    }
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
  static async getSessionTokens(): Promise<{
    accessToken: string;
    refreshToken: string;
  } | null> {
    // Ensure token is fresh before reading from storage
    if (this.authProvider) {
      await this.authProvider.ensureFreshToken();
    }

    if (!this.context) {
      logger.warn('SupabaseClient', 'Extension context not set');
      const accessToken = await this.getAccessToken();
      if (!accessToken) {
        return null;
      }
      return { accessToken, refreshToken: '' };
    }

    try {
      const sessionData = await this.context.secrets.get(SUPABASE_SESSION_KEY);
      if (!sessionData) {
        return null;
      }

      interface StoredSession {
        accessToken: string;
        refreshToken: string;
      }

      const session: StoredSession = JSON.parse(sessionData);
      return {
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
      };
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
