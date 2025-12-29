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
} from './config';

/** Refresh token if it expires within this threshold (5 minutes) */
const TOKEN_REFRESH_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Singleton Supabase client with authentication helpers.
 */
export class SupabaseClient {
  private static instance: Client | null = null;
  private static config: { url: string; publicKey: string } | null = null;
  private static context: vscode.ExtensionContext | null = null;
  private static readonly SESSION_KEY = 'texra.supabase.session';
  private static refreshPromise: Promise<string | null> | null = null;

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
   * Automatically refreshes the token if it's about to expire.
   */
  static async getAccessToken(): Promise<string | null> {
    try {
      // First check if we have a stored session that needs refresh
      if (this.context) {
        const sessionData = await this.context.secrets.get(this.SESSION_KEY);
        if (sessionData) {
          const stored = JSON.parse(sessionData) as {
            accessToken: string;
            refreshToken: string;
            expiresAt: number;
          };

          // Check if token is expired or about to expire
          const timeUntilExpiry = stored.expiresAt - Date.now();
          if (timeUntilExpiry < TOKEN_REFRESH_THRESHOLD_MS) {
            logger.info(
              'SupabaseClient',
              `Token expires in ${Math.round(timeUntilExpiry / 1000)}s, refreshing proactively`,
            );
            const refreshed = await this.refreshTokenIfNeeded(stored);
            if (refreshed) {
              return refreshed;
            }
            // If refresh failed, fall through to try the existing token
            // (it might still be valid for a few more seconds)
          }
        }
      }

      // Use VS Code's authentication API as fallback
      const session = await vscode.authentication.getSession(
        'texra-supabase',
        [],
        {
          silent: true,
        },
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
   * Refresh the access token if needed, with concurrency protection.
   */
  private static async refreshTokenIfNeeded(session: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  }): Promise<string | null> {
    // Prevent concurrent refresh attempts
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.doRefreshToken(session).finally(() => {
      this.refreshPromise = null;
    });

    return this.refreshPromise;
  }

  /**
   * Perform the actual token refresh.
   */
  private static async doRefreshToken(session: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  }): Promise<string | null> {
    try {
      const { data, error } = await this.getClient().auth.refreshSession({
        refresh_token: session.refreshToken,
      });

      if (error || !data.session) {
        logger.warn(
          'SupabaseClient',
          `Token refresh failed: ${error?.message || 'No session returned'}`,
        );
        return null;
      }

      // Update stored session with new tokens
      const refreshed = {
        id: data.session.user.id,
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
        account: {
          id: data.session.user.id,
          label: data.session.user.email || data.session.user.id,
        },
        expiresAt: data.session.expires_at
          ? data.session.expires_at * 1000
          : Date.now() + 60 * 60 * 1000, // Default 1 hour
      };

      if (this.context) {
        await this.context.secrets.store(
          this.SESSION_KEY,
          JSON.stringify(refreshed),
        );
        logger.info('SupabaseClient', 'Token refreshed successfully');
      }

      return refreshed.accessToken;
    } catch (error) {
      logger.error(
        'SupabaseClient',
        `Error refreshing token: ${toErrorMessage(error)}`,
      );
      return null;
    }
  }

  /**
   * Get access and refresh tokens from secure storage.
   */
  static async getSessionTokens(): Promise<{
    accessToken: string;
    refreshToken: string;
  } | null> {
    if (!this.context) {
      logger.warn('SupabaseClient', 'Extension context not set');
      const accessToken = await this.getAccessToken();
      if (!accessToken) {
        return null;
      }
      return { accessToken, refreshToken: '' };
    }

    try {
      const sessionData = await this.context.secrets.get(this.SESSION_KEY);
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
