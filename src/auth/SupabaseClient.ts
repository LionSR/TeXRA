import {
  createClient,
  SupabaseClient as Client,
  User,
} from '@supabase/supabase-js';
import * as vscode from 'vscode';
import * as logger from '@logger/logUtils';
import type { UserAuthContext } from './config';

/**
 * Singleton Supabase client with authentication helpers.
 */
export class SupabaseClient {
  private static instance: Client | null = null;
  private static config: { url: string; publicKey: string } | null = null;
  private static context: vscode.ExtensionContext | null = null;
  private static readonly SESSION_KEY = 'texra.supabase.session';

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
   * Get user tier (free or researcher).
   * @deprecated Use getUserAuthContext() or getUserPermissions() instead for flexible permission checks.
   * This method is kept for backwards compatibility.
   */
  static async getUserTier(): Promise<'free' | 'researcher'> {
    const authContext = await this.getUserAuthContext();
    // Map primary group to legacy tier values
    const tier = authContext.primaryGroup;
    if (tier === 'researcher') {
      return 'researcher';
    }
    return 'free';
  }

  /**
   * Get the user's authorization context including permissions.
   * Fetches permissions directly from profiles table.
   */
  static async getUserAuthContext(): Promise<UserAuthContext> {
    const defaultContext: UserAuthContext = {
      groups: [],
      permissions: [],
      primaryGroup: 'free',
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

      const tier = (data.tier as string) || 'free';
      let permissions = (data.permissions as string[]) || [];

      // If permissions column is empty, fall back to tier-based permissions
      if (permissions.length === 0 && tier === 'researcher') {
        permissions = ['access_remote_agents', 'access_researcher_visibility'];
      }

      return {
        groups: [], // Simplified - no groups table
        permissions,
        primaryGroup: tier,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(
        'SupabaseClient',
        `Error getting user auth context: ${errorMsg}`,
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
   * Check if user has a specific permission.
   */
  static async hasPermission(permission: string): Promise<boolean> {
    const permissions = await this.getUserPermissions();
    return permissions.includes(permission);
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
