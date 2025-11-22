import {
  createClient,
  SupabaseClient as Client,
  User,
} from '@supabase/supabase-js';
import * as vscode from 'vscode';

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
        persistSession: false, // We handle session persistence via VS Code SecretStorage
        autoRefreshToken: false,
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
      console.error('Error getting access token:', error);
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
      console.error('Error getting user:', error);
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
      // Set auth header for RLS
      const { data, error } = await this.getClient()
        .from('profiles')
        .select('tier')
        .single();

      if (error || !data) {
        console.error('Error fetching user tier:', error);
        return 'free';
      }
      return (data.tier as 'free' | 'premium') || 'free';
    } catch (error) {
      console.error('Error getting user tier:', error);
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
