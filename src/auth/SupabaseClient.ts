import {
  createClient,
  SupabaseClient as Client,
  User,
} from '@supabase/supabase-js';
import * as vscode from 'vscode';
import * as logger from '@logger/logUtils';

/**
 * Singleton Supabase client with authentication helpers.
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
      throw new Error('Supabase credentials missing. Check extension configuration.');
    }
    this.config = { url, anonKey };
    if (context) {
      this.context = context;
    }
    this.instance = createClient(url, anonKey, {
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
      throw new Error('Supabase client not initialized. Restart the extension.');
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
   * Get user tier (free or premium).
   */
  static async getUserTier(): Promise<'free' | 'premium'> {
    const tokens = await this.getSessionTokens();
    if (!tokens) {
      return 'free';
    }

    try {
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

  /** Get configuration for re-initialization. */
  static getConfig(): { url: string; anonKey: string } | null {
    return this.config;
  }
}
