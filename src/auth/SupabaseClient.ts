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

  /**
   * Initialize the Supabase client with project credentials.
   */
  static initialize(url: string, anonKey: string): void {
    if (!url || !anonKey) {
      throw new Error('Supabase URL and anon key are required');
    }
    this.config = { url, anonKey };
    this.instance = createClient(url, anonKey, {
      auth: {
        // Enable persistence temporarily for OAuth flow
        // The session will be stored in browser's localStorage during OAuth callback
        // Then we copy it to VS Code SecretStorage and manage it ourselves
        persistSession: true,
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
    const token = await this.getAccessToken();
    if (!token) {
      return 'free';
    }

    try {
      // Set auth session for RLS
      const client = this.getClient();
      await client.auth.setSession({
        access_token: token,
        refresh_token: '', // Not needed for read-only queries
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
