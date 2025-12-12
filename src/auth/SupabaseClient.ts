import {
  createClient,
  SupabaseClient as Client,
  User,
} from '@supabase/supabase-js';
import * as vscode from 'vscode';
import * as logger from '@logger/logUtils';
import type { UserGroup, UserAuthContext } from './config';

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
   * Get the user's full authorization context including groups and permissions.
   * This is the preferred method for permission checks.
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

      // Fetch user's group memberships with group details
      const { data, error } = await client
        .from('user_group_memberships')
        .select(
          `
          user_groups (
            id,
            name,
            display_name,
            permissions,
            priority
          )
        `,
        )
        .order('user_groups(priority)', { ascending: false });

      if (error) {
        logger.error(
          'SupabaseClient',
          `Error fetching user groups: ${error.message}`,
        );
        // Fall back to legacy tier check
        return this.getLegacyAuthContext();
      }

      if (!data || data.length === 0) {
        // No group memberships found, try legacy tier
        return this.getLegacyAuthContext();
      }

      // Transform data to UserGroup format
      const groups: UserGroup[] = data
        .map((membership) => {
          const group = membership.user_groups as unknown as {
            id: string;
            name: string;
            display_name: string;
            permissions: string[];
            priority: number;
          };
          if (!group) return null;
          return {
            id: group.id,
            name: group.name,
            displayName: group.display_name,
            permissions: group.permissions || [],
            priority: group.priority || 0,
          };
        })
        .filter((g): g is UserGroup => g !== null);

      // Flatten all permissions (deduplicated)
      const permissions = [
        ...new Set(groups.flatMap((g) => g.permissions)),
      ];

      // Primary group is the one with highest priority
      const primaryGroup =
        groups.length > 0 ? groups[0].name : 'free';

      return { groups, permissions, primaryGroup };
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
   * Convenience method for simple permission checks.
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
   * Legacy fallback: get auth context from profiles.tier column.
   * Used when user_groups tables don't exist yet.
   */
  private static async getLegacyAuthContext(): Promise<UserAuthContext> {
    const defaultContext: UserAuthContext = {
      groups: [],
      permissions: [],
      primaryGroup: 'free',
    };

    try {
      const client = this.getClient();
      const { data, error } = await client
        .from('profiles')
        .select('tier')
        .single();

      if (error || !data) {
        return defaultContext;
      }

      const tier = (data.tier as string) || 'free';

      // Map legacy tiers to permissions
      if (tier === 'researcher') {
        return {
          groups: [
            {
              id: 'legacy-researcher',
              name: 'researcher',
              displayName: 'Researcher Access',
              permissions: [
                'access_remote_agents',
                'access_researcher_visibility',
              ],
              priority: 10,
            },
          ],
          permissions: ['access_remote_agents', 'access_researcher_visibility'],
          primaryGroup: 'researcher',
        };
      }

      return defaultContext;
    } catch {
      return defaultContext;
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
  static getConfig(): { url: string; publicKey: string } | null {
    return this.config;
  }
}
