import * as vscode from 'vscode';
import { SupabaseClient } from './SupabaseClient';
import { SUPABASE_CONFIG, DEFAULT_OAUTH_PROVIDER } from './config';

/**
 * Supabase session data stored in VS Code SecretStorage.
 */
interface SupabaseSession {
  id: string;
  accessToken: string;
  refreshToken: string;
  account: {
    id: string;
    label: string; // email or user ID
  };
  expiresAt: number; // timestamp
}

/**
 * Authentication provider for Supabase integration.
 * Implements VS Code's AuthenticationProvider interface to manage
 * user sessions for remote agent access.
 *
 * Uses TeXRA's official Supabase backend (hardcoded credentials).
 * Similar to how GitHub Copilot works - users sign in to the official service.
 */
export class SupabaseAuthProvider implements vscode.AuthenticationProvider {
  private static readonly SESSION_KEY = 'texra.supabase.session';
  private static readonly PROVIDER_ID = 'texra-supabase';

  private _onDidChangeSessions =
    new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
  public readonly onDidChangeSessions = this._onDidChangeSessions.event;

  constructor(private context: vscode.ExtensionContext) {
    // Initialize Supabase client with hardcoded config
    SupabaseClient.initialize(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey);
  }

  /**
   * Get existing sessions from secure storage.
   */
  async getSessions(
    scopes?: readonly string[],
    options?: vscode.AuthenticationProviderSessionOptions,
  ): Promise<vscode.AuthenticationSession[]> {
    const sessionData = await this.context.secrets.get(
      SupabaseAuthProvider.SESSION_KEY,
    );
    if (!sessionData) {
      return [];
    }

    try {
      const session: SupabaseSession = JSON.parse(sessionData);

      // Check if session is expired
      if (Date.now() >= session.expiresAt) {
        // Try to refresh
        const refreshed = await this.refreshSession(session);
        if (!refreshed) {
          await this.removeSession(session.id);
          return [];
        }
        return [this.toVSCodeSession(refreshed)];
      }

      // Verify session is still valid with Supabase
      const { data, error } = await SupabaseClient.getClient().auth.getUser(
        session.accessToken,
      );
      if (error || !data.user) {
        await this.removeSession(session.id);
        return [];
      }

      return [this.toVSCodeSession(session)];
    } catch (error) {
      console.error('Error loading session:', error);
      return [];
    }
  }

  /**
   * Create a new authentication session via OAuth.
   * Uses GitHub as the default provider (can support Google/GitLab too).
   */
  async createSession(
    scopes: readonly string[],
  ): Promise<vscode.AuthenticationSession> {
    try {
      const supabase = SupabaseClient.getClient();

      // Start OAuth flow with default provider (GitHub)
      // TODO: Add UI to let user choose provider if multiple are configured in Supabase
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: DEFAULT_OAUTH_PROVIDER,
        options: {
          redirectTo:
            vscode.env.uriScheme === 'vscode'
              ? 'vscode://LionSR.texra/auth-callback'
              : 'vscode-insiders://LionSR.texra/auth-callback',
        },
      });

      if (error || !data.url) {
        throw new Error(
          `Failed to initiate OAuth: ${error?.message || 'Unknown error'}`,
        );
      }

      // Open OAuth URL in browser
      await vscode.env.openExternal(vscode.Uri.parse(data.url));

      // Show message while waiting for authentication
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'TeXRA Authentication',
          cancellable: true,
        },
        async (progress, token) => {
          progress.report({ message: 'Waiting for authentication...' });

          // Wait for callback with session
          const session = await this.waitForSession(token);
          if (!session) {
            throw new Error('Authentication was cancelled or timed out');
          }

          // Store session
          await this.context.secrets.store(
            SupabaseAuthProvider.SESSION_KEY,
            JSON.stringify(session),
          );

          // Notify listeners
          this._onDidChangeSessions.fire({
            added: [this.toVSCodeSession(session)],
            removed: [],
            changed: [],
          });

          return this.toVSCodeSession(session);
        },
      );

      // Get the stored session
      const sessions = await this.getSessions();
      if (sessions.length === 0) {
        throw new Error('Failed to create session');
      }
      return sessions[0];
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Authentication failed: ${message}`);
      throw error;
    }
  }

  /**
   * Remove an authentication session.
   */
  async removeSession(sessionId: string): Promise<void> {
    try {
      // Sign out from Supabase
      await SupabaseClient.getClient().auth.signOut();

      // Remove from storage
      await this.context.secrets.delete(SupabaseAuthProvider.SESSION_KEY);

      // Notify listeners
      this._onDidChangeSessions.fire({
        added: [],
        removed: [
          {
            id: sessionId,
            accessToken: '',
            account: { id: '', label: '' },
            scopes: [],
          },
        ],
        changed: [],
      });
    } catch (error) {
      console.error('Error removing session:', error);
    }
  }

  /**
   * Wait for OAuth callback and return session.
   */
  private async waitForSession(
    cancellationToken: vscode.CancellationToken,
  ): Promise<SupabaseSession | null> {
    const supabase = SupabaseClient.getClient();
    const timeout = 120000; // 2 minutes
    const pollInterval = 1000; // 1 second
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      const interval = setInterval(async () => {
        // Check for cancellation
        if (cancellationToken.isCancellationRequested) {
          clearInterval(interval);
          resolve(null);
          return;
        }

        // Check for timeout
        if (Date.now() - startTime > timeout) {
          clearInterval(interval);
          reject(new Error('Authentication timeout'));
          return;
        }

        // Poll for session
        try {
          const { data } = await supabase.auth.getSession();
          if (data.session) {
            clearInterval(interval);

            const session: SupabaseSession = {
              id: data.session.user.id,
              accessToken: data.session.access_token,
              refreshToken: data.session.refresh_token,
              account: {
                id: data.session.user.id,
                label: data.session.user.email || data.session.user.id,
              },
              expiresAt: (data.session.expires_at || 0) * 1000, // Convert to milliseconds
            };

            resolve(session);
          }
        } catch (error) {
          console.error('Error polling for session:', error);
        }
      }, pollInterval);
    });
  }

  /**
   * Refresh an expired session.
   */
  private async refreshSession(
    session: SupabaseSession,
  ): Promise<SupabaseSession | null> {
    try {
      const { data, error } =
        await SupabaseClient.getClient().auth.refreshSession({
          refresh_token: session.refreshToken,
        });

      if (error || !data.session) {
        return null;
      }

      const refreshed: SupabaseSession = {
        id: data.session.user.id,
        accessToken: data.session.access_token,
        refreshToken: data.session.refresh_token,
        account: {
          id: data.session.user.id,
          label: data.session.user.email || data.session.user.id,
        },
        expiresAt: (data.session.expires_at || 0) * 1000,
      };

      // Update stored session
      await this.context.secrets.store(
        SupabaseAuthProvider.SESSION_KEY,
        JSON.stringify(refreshed),
      );

      return refreshed;
    } catch (error) {
      console.error('Error refreshing session:', error);
      return null;
    }
  }

  /**
   * Convert internal session to VS Code session format.
   */
  private toVSCodeSession(
    session: SupabaseSession,
  ): vscode.AuthenticationSession {
    return {
      id: session.id,
      accessToken: session.accessToken,
      account: session.account,
      scopes: [],
    };
  }
}
