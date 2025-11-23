import {
  createClient,
  SupabaseClient as Client,
  User,
} from '@supabase/supabase-js';
import * as vscode from 'vscode';
import * as logger from '@logger/logUtils';

/**
 * Singleton wrapper for Supabase client with authentication helpers.
 * Provides centralized access to Supabase services and user session management.
 */
export class SupabaseClient {
  private static instance: Client | null = null;
  private static config: { url: string; anonKey: string } | null = null;
  private static context: vscode.ExtensionContext | null = null;
  private static readonly SESSION_KEY = 'texra.supabase.session';

  /**
   * Initialize the Supabase client with project credentials.
   */
  static initialize(
    url: string,
    anonKey: string,
    context?: vscode.ExtensionContext,
  ): void {
    if (!url || !anonKey) {
      throw new Error('Supabase URL and anon key are required');
    }
    this.config = { url, anonKey };
    if (context) {
      this.context = context;
    }
    this.instance = createClient(url, anonKey, {
      auth: {
        // Disable persistence - we handle session via VS Code SecretStorage
        // OAuth callbacks are captured via URI handler and tokens extracted from URL
        persistSession: false,
        autoRefreshToken: false, // We handle refresh manually via VS Code auth provider
      },
    });
  }

  /**
   * Get the Supabase client instance.
   */
  static getClient(): Client {
    if (!this.instance) {
      throw new Error(
        'Supabase client not initialized. Call initialize() first.',
      );
    }
    return this.instance;
  }

  /**
   * Get the current user's access token from VS Code authentication.
   */
  static async getAccessToken(): Promise<string | null> {
    try {
      const session = await vscode.authentication.getSession(
        'texra-supabase',
        [],
        {
          silent: true,
        },
      );
      return session?.accessToken || null;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error('SupabaseClient', `Error getting access token: ${errorMsg}`);
      return null;
    }
  }

  /**
   * Get both access and refresh tokens from secure storage.
   * This is needed when calling Supabase auth.setSession() which requires both tokens.
   */
  static async getSessionTokens(): Promise<{
    accessToken: string;
    refreshToken: string;
  } | null> {
    if (!this.context) {
      logger.warn(
        'SupabaseClient',
        'Extension context not set, falling back to access token only',
      );
      const accessToken = await this.getAccessToken();
      if (!accessToken) {
        return null;
      }
      // If context not available, we can't get refresh token
      // This shouldn't happen in normal operation
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
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(
        'SupabaseClient',
        `Error getting session tokens: ${errorMsg}`,
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
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error('SupabaseClient', `Error getting user: ${errorMsg}`);
      return null;
    }
  }

  /**
   * Get the current user's tier (free or premium).
   */
  static async getUserTier(): Promise<'free' | 'premium'> {
    const tokens = await this.getSessionTokens();
    if (!tokens) {
      return 'free';
    }

    try {
      // Set auth session for RLS - requires both tokens
      const client = this.getClient();
      await client.auth.setSession({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
      });

      const { data, error } = await client
        .from('profiles')
        .select('tier')
        .single();

      if (error || !data) {
        const errorMsg = error?.message || 'Unknown error';
        logger.error('SupabaseClient', `Error fetching user tier: ${errorMsg}`);
        return 'free';
      }
      return (data.tier as 'free' | 'premium') || 'free';
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error('SupabaseClient', `Error getting user tier: ${errorMsg}`);
      return 'free';
    }
  }

  /**
   * Check if user is authenticated.
   */
  static async isAuthenticated(): Promise<boolean> {
    const token = await this.getAccessToken();
    return token !== null;
  }

  /**
   * Get configuration (for re-initialization if needed).
   */
  static getConfig(): { url: string; anonKey: string } | null {
    return this.config;
  }
}
