import * as vscode from 'vscode';
import * as logger from '@logger/logUtils';
import { SupabaseClient } from './SupabaseClient';
import {
  SUPABASE_CONFIG,
  DEFAULT_OAUTH_PROVIDER,
  EXTENSION_ID,
} from './config';
import type { SupabaseUriHandler } from './UriHandler';

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
  private static instance: SupabaseAuthProvider | null = null;

  private _onDidChangeSessions =
    new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
  public readonly onDidChangeSessions = this._onDidChangeSessions.event;

  private uriHandler: SupabaseUriHandler | null = null;
  private refreshPromise: Promise<SupabaseSession | null> | null = null;

  constructor(private context: vscode.ExtensionContext) {
    // Initialize Supabase client with hardcoded config and context
    // Context is needed to access secret storage for refresh tokens
    SupabaseClient.initialize(
      SUPABASE_CONFIG.url,
      SUPABASE_CONFIG.anonKey,
      context,
    );
    SupabaseAuthProvider.instance = this;
  }

  /**
   * Get the singleton instance of the auth provider.
   * Used by commands to trigger sign out properly.
   */
  static getInstance(): SupabaseAuthProvider | null {
    return this.instance;
  }

  /**
   * Set the URI handler for OAuth callbacks.
   * Called during extension initialization.
   */
  setUriHandler(handler: SupabaseUriHandler): void {
    this.uriHandler = handler;
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
          // Notify user that session expired and offer to re-authenticate
          const action = await vscode.window.showWarningMessage(
            'Your TeXRA session has expired. Please sign in again to use remote agents.',
            'Sign In',
          );
          if (action === 'Sign In') {
            // Trigger re-authentication
            try {
              await vscode.commands.executeCommand('texra.auth.signIn');
            } catch (error) {
              logger.error(
                'SupabaseAuthProvider',
                `Failed to trigger sign-in: ${error}`,
              );
            }
          }
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
        // Notify user that session is invalid and offer to re-authenticate
        const action = await vscode.window.showWarningMessage(
          'Your TeXRA session is no longer valid. Please sign in again to use remote agents.',
          'Sign In',
        );
        if (action === 'Sign In') {
          // Trigger re-authentication
          try {
            await vscode.commands.executeCommand('texra.auth.signIn');
          } catch (error) {
            logger.error(
              'SupabaseAuthProvider',
              `Failed to trigger sign-in: ${error}`,
            );
          }
        }
        return [];
      }

      return [this.toVSCodeSession(session)];
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(
        'SupabaseAuthProvider',
        `Error loading session: ${errorMsg}`,
      );
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
          redirectTo: `${vscode.env.uriScheme}://${EXTENSION_ID}/auth-callback`,
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
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(
        'SupabaseAuthProvider',
        `Error removing session: ${errorMsg}`,
      );
    }
  }

  /**
   * Wait for OAuth callback via URI handler.
   */
  private async waitForSession(
    cancellationToken: vscode.CancellationToken,
  ): Promise<SupabaseSession | null> {
    if (!this.uriHandler) {
      throw new Error('URI handler not initialized');
    }

    const timeout = 120000; // 2 minutes
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      // Track cleanup state to avoid disposing already-disposed subscriptions
      let isCleanedUp = false;
      const cleanup = () => {
        if (isCleanedUp) return;
        isCleanedUp = true;
        clearTimeout(timeoutHandle);
        subscription.dispose();
        cancellationListener.dispose();
      };

      // Listen for OAuth callback (must be declared before timeout/cancellation handlers use it)
      const subscription = this.uriHandler!.onDidReceiveCallback(
        async (uri) => {
          cleanup();

          try {
            // Parse OAuth callback parameters from fragment (hash)
            // Supabase OAuth uses implicit flow which puts tokens in the fragment, not query
            const params = new URLSearchParams(uri.fragment);
            const accessToken = params.get('access_token');
            const refreshToken = params.get('refresh_token');
            const expiresIn = params.get('expires_in');
            const tokenType = params.get('token_type');

            // Check for error in callback
            const error = params.get('error');
            const errorDescription = params.get('error_description');
            if (error) {
              reject(
                new Error(
                  `OAuth error: ${error} - ${errorDescription || 'Unknown error'}`,
                ),
              );
              return;
            }

            if (!accessToken || !refreshToken) {
              logger.error(
                'SupabaseAuthProvider',
                `Missing tokens in OAuth callback. Has fragment: ${!!uri.fragment}, Has query: ${!!uri.query}`,
              );
              reject(new Error('Missing tokens in OAuth callback'));
              return;
            }

            // Get user info from access token
            const supabase = SupabaseClient.getClient();
            const { data, error: userError } =
              await supabase.auth.getUser(accessToken);

            if (userError || !data.user) {
              reject(
                new Error(
                  `Failed to get user info: ${userError?.message || 'Unknown error'}`,
                ),
              );
              return;
            }

            // Calculate expiration time
            const expiresAt = expiresIn
              ? Date.now() + parseInt(expiresIn) * 1000
              : Date.now() + 3600000; // Default 1 hour

            const session: SupabaseSession = {
              id: data.user.id,
              accessToken,
              refreshToken,
              account: {
                id: data.user.id,
                label: data.user.email || data.user.id,
              },
              expiresAt,
            };

            resolve(session);
          } catch (error) {
            const errorMsg =
              error instanceof Error ? error.message : String(error);
            logger.error(
              'SupabaseAuthProvider',
              `Error processing OAuth callback: ${errorMsg}`,
            );
            reject(error);
          }
        },
      );

      // Set up timeout
      const timeoutHandle = setTimeout(() => {
        cleanup();
        reject(new Error('Authentication timeout'));
      }, timeout);

      // Listen for cancellation
      if (cancellationToken.isCancellationRequested) {
        cleanup();
        resolve(null);
        return;
      }

      const cancellationListener = cancellationToken.onCancellationRequested(
        () => {
          cleanup();
          resolve(null);
        },
      );
    });
  }

  /**
   * Refresh an expired session.
   * Uses a promise lock to prevent concurrent refresh attempts.
   */
  private async refreshSession(
    session: SupabaseSession,
  ): Promise<SupabaseSession | null> {
    // If a refresh is already in progress, wait for it
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    // Start a new refresh and store the promise
    this.refreshPromise = this._refreshSession(session).finally(() => {
      this.refreshPromise = null;
    });

    return this.refreshPromise;
  }

  /**
   * Internal method to actually perform the refresh.
   */
  private async _refreshSession(
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
        // If expires_at is missing, default to 1 hour from now to avoid immediate expiration
        expiresAt: data.session.expires_at
          ? data.session.expires_at * 1000
          : Date.now() + 3600000,
      };

      // Update stored session
      await this.context.secrets.store(
        SupabaseAuthProvider.SESSION_KEY,
        JSON.stringify(refreshed),
      );

      return refreshed;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(
        'SupabaseAuthProvider',
        `Error refreshing session: ${errorMsg}`,
      );
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
