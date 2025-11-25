import * as vscode from 'vscode';
import * as logger from '@logger/logUtils';
import { SupabaseClient } from './SupabaseClient';
import {
  SUPABASE_CONFIG,
  DEFAULT_OAUTH_PROVIDER,
  EXTENSION_ID,
} from './config';
import type { SupabaseUriHandler } from './UriHandler';

/** Session data stored in VS Code SecretStorage. */
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
 * Manages user sessions for remote agent access.
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
    SupabaseClient.initialize(
      SUPABASE_CONFIG.url,
      SUPABASE_CONFIG.anonKey,
      context,
    );
    SupabaseAuthProvider.instance = this;
  }

  /** Get singleton instance for sign out operations. */
  static getInstance(): SupabaseAuthProvider | null {
    return this.instance;
  }

  /** Set URI handler for OAuth callbacks. */
  setUriHandler(handler: SupabaseUriHandler): void {
    this.uriHandler = handler;
  }

  /** Get sessions from secure storage. */
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

      if (Date.now() >= session.expiresAt) {
        const refreshed = await this.refreshSession(session);
        if (!refreshed) {
          await this.removeSession(session.id);
          const action = await vscode.window.showWarningMessage(
            'Your TeXRA session has expired. Please sign in again to use remote agents.',
            'Sign In',
          );
          if (action === 'Sign In') {
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
        const action = await vscode.window.showWarningMessage(
          'Your TeXRA session is no longer valid. Please sign in again to use remote agents.',
          'Sign In',
        );
        if (action === 'Sign In') {
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

  /** Create authentication session via OAuth. */
  async createSession(
    scopes: readonly string[],
  ): Promise<vscode.AuthenticationSession> {
    try {
      const supabase = SupabaseClient.getClient();

      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: DEFAULT_OAUTH_PROVIDER,
        options: {
          redirectTo: `${vscode.env.uriScheme}://${EXTENSION_ID}/auth-callback`,
        },
      });

      if (error || !data.url) {
        throw new Error(
          `OAuth initialization failed: ${error?.message || 'Unknown error'}. Try again.`,
        );
      }

      await vscode.env.openExternal(vscode.Uri.parse(data.url));
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'TeXRA Authentication',
          cancellable: true,
        },
        async (progress, token) => {
          progress.report({ message: 'Waiting for authentication...' });
          const session = await this.waitForSession(token);
          if (!session) {
            throw new Error('Authentication cancelled or timed out. Try again.');
          }
          await this.context.secrets.store(
            SupabaseAuthProvider.SESSION_KEY,
            JSON.stringify(session),
          );
          this._onDidChangeSessions.fire({
            added: [this.toVSCodeSession(session)],
            removed: [],
            changed: [],
          });

          return this.toVSCodeSession(session);
        },
      );
      const sessions = await this.getSessions();
      if (sessions.length === 0) {
        throw new Error('Session creation failed. Try signing in again.');
      }
      return sessions[0];
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Authentication failed: ${message}`);
      throw error;
    }
  }

  /** Remove authentication session. */
  async removeSession(sessionId: string): Promise<void> {
    try {
      await SupabaseClient.getClient().auth.signOut();
      await this.context.secrets.delete(SupabaseAuthProvider.SESSION_KEY);
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

  /** Wait for OAuth callback. */
  private async waitForSession(
    cancellationToken: vscode.CancellationToken,
  ): Promise<SupabaseSession | null> {
    if (!this.uriHandler) {
      throw new Error('OAuth handler not initialized. Restart the extension.');
    }

    const timeout = 120000; // 2 minutes
    const startTime = Date.now();

    return new Promise((resolve, reject) => {
      let isCleanedUp = false;
      let cancellationListener: vscode.Disposable | undefined = undefined;

      const cleanup = () => {
        if (isCleanedUp) return;
        isCleanedUp = true;
        clearTimeout(timeoutHandle);
        subscription.dispose();
        cancellationListener?.dispose();
      };
      const subscription = this.uriHandler!.onDidReceiveCallback(
        async (uri) => {
          cleanup();

          try {
            const params = new URLSearchParams(uri.fragment);
            const accessToken = params.get('access_token');
            const refreshToken = params.get('refresh_token');
            const expiresIn = params.get('expires_in');
            const tokenType = params.get('token_type');
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
              reject(new Error('OAuth callback missing tokens. Try again.'));
              return;
            }
            const supabase = SupabaseClient.getClient();
            const { data, error: userError } =
              await supabase.auth.getUser(accessToken);

            if (userError || !data.user) {
              reject(
                new Error(
                  `User verification failed: ${userError?.message || 'Unknown error'}. Try again.`,
                ),
              );
              return;
            }
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
      const timeoutHandle = setTimeout(() => {
        cleanup();
        reject(new Error('Authentication timed out. Try again.'));
      }, timeout);
      if (cancellationToken.isCancellationRequested) {
        cleanup();
        resolve(null);
        return;
      }

      cancellationListener = cancellationToken.onCancellationRequested(() => {
        cleanup();
        resolve(null);
      });
    });
  }

  /** Refresh session with concurrency protection. */
  private async refreshSession(
    session: SupabaseSession,
  ): Promise<SupabaseSession | null> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }
    this.refreshPromise = this._refreshSession(session).finally(() => {
      this.refreshPromise = null;
    });

    return this.refreshPromise;
  }
  private async _refreshSession(
    session: SupabaseSession,
  ): Promise<SupabaseSession | null> {
    try {
      const { data, error } = await SupabaseClient.getClient().auth.refreshSession({
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
  private toVSCodeSession(session: SupabaseSession): vscode.AuthenticationSession {
    return {
      id: session.id,
      accessToken: session.accessToken,
      account: session.account,
      scopes: [],
    };
  }
}
