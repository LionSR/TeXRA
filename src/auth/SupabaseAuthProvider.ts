import * as vscode from 'vscode';
import { toErrorMessage } from '@common/errors/errorHandlingUtils';
import * as logger from '@logger/logUtils';
import { SupabaseClient } from './SupabaseClient';
import {
  SUPABASE_CONFIG,
  DEFAULT_OAUTH_PROVIDER,
  OAUTH_PROVIDERS,
  getAuthCallbackUri,
  AUTH_CALLBACK_TIMEOUT_MS,
  TOKEN_REFRESH_THRESHOLD_MS,
  DEFAULT_SESSION_EXPIRY_MS,
  SUPABASE_SESSION_KEY,
  type OAuthProvider,
} from './config';
import { getServerSideKeyService } from './serverKeys';
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

/** Result of parsing auth callback URI */
interface CallbackParseResult {
  success: true;
  session: SupabaseSession;
}

interface CallbackParseError {
  success: false;
  error: string;
  isAuthError?: boolean;
}

type CallbackResult = CallbackParseResult | CallbackParseError;

/**
 * Type guard to check if a string is a valid OAuth provider.
 */
function isOAuthProvider(value: string | undefined): value is OAuthProvider {
  return (
    value !== undefined && OAUTH_PROVIDERS.includes(value as OAuthProvider)
  );
}

/**
 * Authentication provider for Supabase integration.
 * Manages user sessions for remote agent access.
 */
export class SupabaseAuthProvider implements vscode.AuthenticationProvider {
  private static instance: SupabaseAuthProvider | null = null;

  private _onDidChangeSessions =
    new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
  public readonly onDidChangeSessions = this._onDidChangeSessions.event;

  private uriHandler: SupabaseUriHandler | null = null;
  private uriHandlerSubscription: vscode.Disposable | null = null;
  private refreshPromise: Promise<SupabaseSession | null> | null = null;
  /** Flag to prevent race conditions between OAuth and magic link handlers */
  private isProcessingCallback = false;

  constructor(private context: vscode.ExtensionContext) {
    SupabaseClient.initialize(
      SUPABASE_CONFIG.url,
      SUPABASE_CONFIG.publicKey,
      context,
    );
    SupabaseAuthProvider.instance = this;
  }

  /** Get singleton instance for sign out operations. */
  static getInstance(): SupabaseAuthProvider | null {
    return this.instance;
  }

  /**
   * Ensure the access token is fresh, refreshing proactively if near expiry.
   * Called by SupabaseClient.getAccessToken() to avoid token expiration during
   * long-running operations (e.g., GPT-5 background mode).
   *
   * @returns Fresh access token, or null if no session or refresh failed
   */
  async ensureFreshToken(): Promise<string | null> {
    try {
      const sessionData = await this.context.secrets.get(
        SUPABASE_SESSION_KEY,
      );
      if (!sessionData) {
        return null;
      }

      const session: SupabaseSession = JSON.parse(sessionData);
      const timeUntilExpiry = session.expiresAt - Date.now();

      // Refresh proactively if token expires within threshold
      if (timeUntilExpiry < TOKEN_REFRESH_THRESHOLD_MS) {
        logger.info(
          'SupabaseAuthProvider',
          `Token expires in ${Math.round(timeUntilExpiry / 1000)}s, refreshing proactively`,
        );
        const refreshed = await this.refreshSession(session);
        if (refreshed) {
          return refreshed.accessToken;
        }
        // If token is already expired and refresh failed, return null
        // to trigger VS Code auth fallback instead of returning expired token
        if (timeUntilExpiry <= 0) {
          logger.warn(
            'SupabaseAuthProvider',
            'Token expired and refresh failed, returning null',
          );
          return null;
        }
        // Token still valid but refresh failed - return existing token
      }

      return session.accessToken;
    } catch (error) {
      logger.error(
        'SupabaseAuthProvider',
        `Error ensuring fresh token: ${toErrorMessage(error)}`,
      );
      return null;
    }
  }

  /**
   * Set URI handler for OAuth callbacks.
   * @param handler - The URI handler to use for auth callbacks
   */
  setUriHandler(handler: SupabaseUriHandler): void {
    // Dispose previous subscription if any
    this.uriHandlerSubscription?.dispose();

    this.uriHandler = handler;

    // Set up persistent listener for magic link callbacks
    // This handles cases where user clicks magic link outside of active OAuth flow
    this.uriHandlerSubscription = handler.onDidReceiveCallback(async (uri) => {
      await this.handleMagicLinkCallback(uri);
    });
  }

  /**
   * Dispose resources when provider is deactivated.
   */
  dispose(): void {
    this.uriHandlerSubscription?.dispose();
    this._onDidChangeSessions.dispose();
  }

  /**
   * Handle magic link callback when user clicks email link.
   * This runs for all auth callbacks, but only processes if no session exists
   * and no OAuth flow is currently active.
   */
  private async handleMagicLinkCallback(uri: vscode.Uri): Promise<void> {
    // Atomically claim processing - must be first check to prevent race
    if (this.isProcessingCallback) {
      return;
    }
    this.isProcessingCallback = true;

    try {
      // Check if we already have a session (after claiming the lock)
      const existingSession = await this.context.secrets.get(
        SUPABASE_SESSION_KEY,
      );
      if (existingSession) {
        return;
      }

      const result = await this.parseCallbackAndCreateSession(uri);

      if (!result.success) {
        if (result.isAuthError) {
          void vscode.window.showErrorMessage(
            `Sign-in failed: ${result.error}`,
          );
        } else {
          // Log non-auth errors for debugging (e.g., missing tokens from non-auth callbacks)
          logger.debug(
            'SupabaseAuthProvider',
            `Magic link callback ignored: ${result.error}`,
          );
        }
        return;
      }

      // Store session and notify - wrapped in try to ensure cleanup on partial failure
      try {
        await this.context.secrets.store(
          SUPABASE_SESSION_KEY,
          JSON.stringify(result.session),
        );
        // Clear server-side key access cache so it refetches with new auth state
        getServerSideKeyService().clearAllCaches();

        this._onDidChangeSessions.fire({
          added: [this.toVSCodeSession(result.session)],
          removed: [],
          changed: [],
        });

        void vscode.window.showInformationMessage(
          `Signed in as ${result.session.account.label}`,
        );

        logger.info(
          'SupabaseAuthProvider',
          `Magic link sign-in successful for ${result.session.account.label}`,
        );
      } catch (storeError) {
        logger.error(
          'SupabaseAuthProvider',
          `Failed to store session: ${toErrorMessage(storeError)}`,
        );
        void vscode.window.showErrorMessage(
          `Sign-in failed: Could not save session`,
        );
      }
    } catch (error) {
      logger.error(
        'SupabaseAuthProvider',
        `Error processing magic link callback: ${toErrorMessage(error)}`,
      );
      void vscode.window.showErrorMessage(
        `Sign-in failed: ${toErrorMessage(error)}`,
      );
    } finally {
      this.isProcessingCallback = false;
    }
  }

  /**
   * Parse auth callback URI and create a session.
   * Shared logic for both OAuth and magic link flows.
   */
  private async parseCallbackAndCreateSession(
    uri: vscode.Uri,
  ): Promise<CallbackResult> {
    const params = new URLSearchParams(uri.fragment);
    const accessToken = params.get('access_token');
    const refreshToken = params.get('refresh_token');
    const expiresIn = params.get('expires_in');
    const error = params.get('error');
    const errorDescription = params.get('error_description');

    if (error) {
      return {
        success: false,
        error: errorDescription || error,
        isAuthError: true,
      };
    }

    if (!accessToken || !refreshToken) {
      return {
        success: false,
        error: 'Missing tokens in callback',
      };
    }

    // Verify user with Supabase
    const supabase = SupabaseClient.getClient();
    const { data, error: userError } = await supabase.auth.getUser(accessToken);

    if (userError || !data.user) {
      return {
        success: false,
        error: userError?.message || 'User verification failed',
        isAuthError: true,
      };
    }

    const expiresAt = expiresIn
      ? Date.now() + parseInt(expiresIn) * 1000
      : Date.now() + DEFAULT_SESSION_EXPIRY_MS;

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

    return { success: true, session };
  }

  /** Get sessions from secure storage. */
  async getSessions(
    _scopes?: readonly string[],
    _options?: vscode.AuthenticationProviderSessionOptions,
  ): Promise<vscode.AuthenticationSession[]> {
    const sessionData = await this.context.secrets.get(
      SUPABASE_SESSION_KEY,
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
            'Your TeXRA session has expired. Please sign in again to access AI models and remote agents.',
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
          'Your TeXRA session is no longer valid. Please sign in again to access AI models and remote agents.',
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
      logger.error(
        'SupabaseAuthProvider',
        `Error loading session: ${toErrorMessage(error)}`,
      );
      return [];
    }
  }

  /**
   * Create authentication session via OAuth.
   * @param scopes - Scopes array, may contain provider hint as "provider:github"
   */
  async createSession(
    scopes: readonly string[],
  ): Promise<vscode.AuthenticationSession> {
    try {
      const supabase = SupabaseClient.getClient();

      // Extract provider from scopes (format: "provider:github" or "provider:google")
      const providerScope = scopes.find((s) => s.startsWith('provider:'));
      const requestedProvider = providerScope?.split(':')[1];
      const provider = isOAuthProvider(requestedProvider)
        ? requestedProvider
        : DEFAULT_OAUTH_PROVIDER;

      const { data, error } = await supabase.auth.signInWithOAuth({
        provider,
        options: {
          redirectTo: getAuthCallbackUri(vscode.env.uriScheme),
        },
      });

      if (error || !data.url) {
        throw new Error(
          `OAuth initialization failed: ${error?.message || 'Unknown error'}. Try again.`,
        );
      }

      // Set flag BEFORE opening URL to prevent race with fast callbacks
      this.isProcessingCallback = true;

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
            throw new Error(
              'Authentication cancelled or timed out. Try again.',
            );
          }
          await this.context.secrets.store(
            SUPABASE_SESSION_KEY,
            JSON.stringify(session),
          );
          // Clear server-side key access cache so it refetches with new auth state
          getServerSideKeyService().clearAllCaches();
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
    } finally {
      // Reset flag after entire OAuth flow completes (success or failure)
      this.isProcessingCallback = false;
    }
  }

  /** Remove authentication session. */
  async removeSession(sessionId: string): Promise<void> {
    try {
      await SupabaseClient.getClient().auth.signOut();
      await this.context.secrets.delete(SUPABASE_SESSION_KEY);
      // Clear server-side key cache when session is removed (handles automatic invalidation)
      getServerSideKeyService().clearAllCaches();
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
      logger.error(
        'SupabaseAuthProvider',
        `Error removing session: ${toErrorMessage(error)}`,
      );
    }
  }

  /**
   * Wait for OAuth callback from URI handler.
   * Note: isProcessingCallback must be set by caller before invoking this method.
   * @param cancellationToken - Token to cancel the wait
   */
  private async waitForSession(
    cancellationToken: vscode.CancellationToken,
  ): Promise<SupabaseSession | null> {
    if (!this.uriHandler) {
      throw new Error('OAuth handler not initialized. Restart the extension.');
    }

    return new Promise((resolve, reject) => {
      let isCleanedUp = false;
      let cancellationListener: vscode.Disposable | undefined = undefined;

      const cleanupListeners = () => {
        if (isCleanedUp) return;
        isCleanedUp = true;
        clearTimeout(timeoutHandle);
        subscription.dispose();
        cancellationListener?.dispose();
      };

      // Flag reset is handled by createSession's finally block
      const subscription = this.uriHandler!.onDidReceiveCallback(
        async (uri) => {
          cleanupListeners();

          try {
            const result = await this.parseCallbackAndCreateSession(uri);

            if (!result.success) {
              if (result.error === 'Missing tokens in callback') {
                logger.error(
                  'SupabaseAuthProvider',
                  `Missing tokens in OAuth callback. Has fragment: ${!!uri.fragment}, Has query: ${!!uri.query}`,
                );
              }
              reject(new Error(`OAuth error: ${result.error}. Try again.`));
              return;
            }

            resolve(result.session);
          } catch (error) {
            logger.error(
              'SupabaseAuthProvider',
              `Error processing OAuth callback: ${toErrorMessage(error)}`,
            );
            reject(error);
          }
        },
      );

      const timeoutHandle = setTimeout(() => {
        cleanupListeners();
        reject(new Error('Authentication timed out. Try again.'));
      }, AUTH_CALLBACK_TIMEOUT_MS);

      if (cancellationToken.isCancellationRequested) {
        cleanupListeners();
        resolve(null);
        return;
      }

      cancellationListener = cancellationToken.onCancellationRequested(() => {
        cleanupListeners();
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
        expiresAt: data.session.expires_at
          ? data.session.expires_at * 1000
          : Date.now() + DEFAULT_SESSION_EXPIRY_MS,
      };

      // Update stored session
      await this.context.secrets.store(
        SUPABASE_SESSION_KEY,
        JSON.stringify(refreshed),
      );

      return refreshed;
    } catch (error) {
      logger.error(
        'SupabaseAuthProvider',
        `Error refreshing session: ${toErrorMessage(error)}`,
      );
      return null;
    }
  }

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
