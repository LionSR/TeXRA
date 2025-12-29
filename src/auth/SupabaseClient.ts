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
  ensureFreshToken(): Promise<string | null>;
}

/**
 * Singleton Supabase client with authentication helpers.
 */
export class SupabaseClient {
  private static instance: Client | null = null;
  private static config: { url: string; publicKey: string } | null = null;
  private static context: vscode.ExtensionContext | null = null;
  private static authProvider: AuthTokenProvider | null = null;

  /**
   * Register an auth provider for token refresh.
   * Called by SupabaseAuthProvider on initialization.
   */
  static setAuthProvider(provider: AuthTokenProvider): void {
    this.authProvider = provider;
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
   * Get the current user's access token from VS Code authentication.
   * Automatically refreshes the token if it's about to expire via the registered auth provider.
   */
  static async getAccessToken(): Promise<string | null> {
    try {
      // Use registered auth provider for proactive token refresh
      if (this.authProvider) {
        const token = await this.authProvider.ensureFreshToken();
        if (token) {
          return token;
        }
        logger.debug(
          'SupabaseClient',
          'ensureFreshToken returned null, falling back to VS Code auth',
        );
      } else {
        logger.debug(
          'SupabaseClient',
          'Auth provider not registered, using VS Code auth fallback',
        );
      }

      // Fallback to VS Code's authentication API
      const session = await vscode.authentication.getSession(
        'texra-supabase',
        [],
        { silent: true },
      );
      return session?.accessToken || null;
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
    if (!token) {
      return null;
    }

    try {
      const { data, error } = await this.getClient().auth.getUser(token);
      if (error || !data.user) {
        return null;
      }
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
    const defaultContext: UserAuthContext = {
      permissions: [],
      tier: 'free',
    };

    const tokens = await this.getSessionTokens();
    if (!tokens) {
      return defaultContext;
    }

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
