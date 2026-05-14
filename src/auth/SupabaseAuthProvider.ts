import * as vscode from 'vscode';
import { toErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';
import { SupabaseClient } from './SupabaseClient';
import {
  DEFAULT_OAUTH_PROVIDER,
  getAuthCallbackUri,
  getExternalAuthCallbackInfo,
  AUTH_CALLBACK_TIMEOUT_MS,
  GITHUB_TOKEN_EXCHANGE_URL,
  DEFAULT_SESSION_EXPIRY_MS,
  isOAuthProvider,
  type OAuthProvider,
} from './config';
import {
  DEFAULT_AUTH_EDGE_FUNCTION_TIMEOUT_MS,
  createSupabaseAuthCoordinator,
  createSupabaseSessionStorage,
} from './SupabaseAuthCoordinator';
import { getServerSideKeyService } from './serverKeys';
import {
  fetchWithTimeout,
  parseTokenExchangeResponse,
  SupabaseSessionCoordinator,
  toStorableGitHubTokenExchangeSession,
  type SupabaseSession,
} from './SupabaseSession';
import type { SupabaseUriHandler } from './UriHandler';

const AUTH_URI_HANDLER_NOT_INITIALIZED =
  'OAuth handler not initialized. Restart the extension.';

/** GitHub token type prefixes for diagnostic logging. */
const GITHUB_TOKEN_TYPE_MAP: Record<string, string> = {
  ghp_: 'classic PAT',
  gho_: 'OAuth token',
  ghu_: 'user-to-server token',
  ghs_: 'server-to-server token',
};

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
  private readonly sessionCoordinator: SupabaseSessionCoordinator;
  /** Flag to prevent race conditions between OAuth and magic link handlers */
  private isProcessingCallback = false;

  constructor(private context: vscode.ExtensionContext) {
    this.sessionCoordinator = createSupabaseAuthCoordinator({
      storage: createSupabaseSessionStorage({
        get: (key) => Promise.resolve(context.secrets.get(key)),
        set: (key, value) => Promise.resolve(context.secrets.store(key, value)),
        delete: (key) => Promise.resolve(context.secrets.delete(key)),
      }),
      whenReady: async () => {
        if (!this.uriHandler) {
          throw new Error(AUTH_URI_HANDLER_NOT_INITIALIZED);
        }
      },
      log: logger,
    });
    SupabaseAuthProvider.instance = this;
  }

  /** Get singleton instance for sign out operations. */
  static getInstance(): SupabaseAuthProvider | null {
    return this.instance;
  }

  /**
   * Store session with optional notification.
   * @param notify - If true, fires session change event and clears caches (for new logins)
   */
  private async storeSession(
    session: SupabaseSession,
    notify = false,
  ): Promise<void> {
    await this.sessionCoordinator.storeSession(session);
    if (notify) {
      getServerSideKeyService().clearAllCaches();
      this._onDidChangeSessions.fire({
        added: [this.toVSCodeSession(session)],
        removed: [],
        changed: [],
      });
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
      const existingSession = await this.sessionCoordinator.loadSession();
      if (existingSession) {
        return;
      }

      const result = await this.sessionCoordinator.createSessionFromCallback({
        path: uri.path,
        query: uri.query,
        fragment: uri.fragment,
      });

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

      await this.storeSession(result.session, true);
      void vscode.window.showInformationMessage(
        `Signed in as ${result.session.account.label}`,
      );
      logger.info(
        'SupabaseAuthProvider',
        `Magic link sign-in successful for ${result.session.account.label}`,
      );
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

  /** Get sessions from secure storage. */
  async getSessions(
    _scopes?: readonly string[],
    _options?: vscode.AuthenticationProviderSessionOptions,
  ): Promise<vscode.AuthenticationSession[]> {
    const session = await this.sessionCoordinator.loadSession();
    if (!session) {
      return [];
    }

    // Seed in-memory expiry cache unconditionally so pre-invocation checks
    // work even if the getUser() validation below throws.
    SupabaseClient.setTokenExpiry(session.expiresAt);

    try {
      if (Date.now() >= session.expiresAt) {
        const refreshed = await this.sessionCoordinator.refreshSession(session);
        if (!refreshed) {
          await this.handleInvalidSession(session.id, 'expired');
          return [];
        }
        return [this.toVSCodeSession(refreshed)];
      }

      const { data, error } = await SupabaseClient.getClient().auth.getUser(
        session.accessToken,
      );
      if (error || !data.user) {
        await this.handleInvalidSession(session.id, 'invalid');
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
   * Handle invalid session by removing it and prompting user to sign in again.
   */
  private async handleInvalidSession(
    sessionId: string,
    reason: 'expired' | 'invalid',
  ): Promise<void> {
    await this.removeSession(sessionId);
    const message =
      reason === 'expired'
        ? 'Your TeXRA session has expired. Please sign in again to access AI models and remote agents.'
        : 'Your TeXRA session is no longer valid. Please sign in again to access AI models and remote agents.';
    const action = await vscode.window.showWarningMessage(message, 'Sign In');
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
  }

  private isWebEnvironment(): boolean {
    return vscode.env.uiKind === vscode.UIKind.Web;
  }

  private async buildOAuthOptions(
    isWeb: boolean,
  ): Promise<{ redirectTo: string; queryParams?: Record<string, string> }> {
    if (isWeb) {
      const callbackInfo = await getExternalAuthCallbackInfo();
      logger.info(
        'SupabaseAuthProvider',
        `OAuth callback URI (web): ${callbackInfo.fullUrl}`,
      );
      return callbackInfo.vscodeState
        ? {
            redirectTo: callbackInfo.baseUrl,
            queryParams: { state: callbackInfo.vscodeState },
          }
        : { redirectTo: callbackInfo.baseUrl };
    }

    const redirectTo = getAuthCallbackUri(vscode.env.uriScheme);
    logger.info(
      'SupabaseAuthProvider',
      `OAuth callback URI (desktop): ${redirectTo}`,
    );
    return { redirectTo };
  }

  /**
   * Create authentication session via OAuth.
   *
   * For GitHub: Uses VS Code's built-in GitHub authentication provider.
   * This works seamlessly across all environments (desktop, Codespaces, Remote SSH)
   * and avoids OAuth callback complexity. The GitHub token is exchanged for a
   * Supabase session via Edge Function.
   *
   * For GitHub (Browser): Uses traditional Supabase OAuth flow via web browser.
   * This is an alternative when VS Code's built-in auth is not preferred.
   *
   * For other providers (Google): Uses traditional Supabase OAuth flow with
   * environment-appropriate callback URIs.
   *
   * @param scopes - Scopes array, may contain provider hint as "provider:github", "provider:github-browser", or "provider:google"
   */
  async createSession(
    scopes: readonly string[],
  ): Promise<vscode.AuthenticationSession> {
    // Extract provider from scopes (format: "provider:github", "provider:github-browser", or "provider:google")
    const requestedProvider = scopes
      .find((s) => s.startsWith('provider:'))
      ?.split(':')[1];

    // Route to appropriate auth flow based on provider
    if (requestedProvider === 'github-browser') {
      logger.info(
        'SupabaseAuthProvider',
        'Using browser-based GitHub auth (Supabase OAuth flow)',
      );
      return this.createSessionViaSupabaseOAuth('github');
    }

    if (!requestedProvider || requestedProvider === 'github') {
      // Default to VS Code's built-in GitHub auth - works everywhere and is simpler
      logger.info(
        'SupabaseAuthProvider',
        'Using VS Code GitHub auth (works on desktop and Codespaces)',
      );
      return this.createSessionViaVSCodeGitHub();
    }

    // Other providers (Google) use traditional Supabase OAuth flow
    return this.createSessionViaSupabaseOAuth(
      isOAuthProvider(requestedProvider)
        ? requestedProvider
        : DEFAULT_OAUTH_PROVIDER,
    );
  }

  /**
   * Create session using VS Code's built-in GitHub authentication.
   * Works on desktop, Codespaces, Remote SSH - anywhere VS Code runs.
   * Exchanges the GitHub token for a Supabase session via Edge Function.
   */
  private async createSessionViaVSCodeGitHub(): Promise<vscode.AuthenticationSession> {
    try {
      // Use VS Code's built-in GitHub auth - works perfectly in Codespaces
      const githubSession = await vscode.authentication.getSession(
        'github',
        ['user:email'],
        { createIfNone: true },
      );

      if (!githubSession) {
        throw new Error('GitHub authentication was cancelled');
      }

      // Log token format to help diagnose auth issues (token prefix indicates type)
      const tokenPrefix = githubSession.accessToken.substring(0, 4);
      const tokenType = GITHUB_TOKEN_TYPE_MAP[tokenPrefix] ?? 'unknown format';

      logger.info(
        'SupabaseAuthProvider',
        `Got VS Code GitHub session for ${githubSession.account.label} (scopes: ${githubSession.scopes.join(', ') || 'default'}, token type: ${tokenType})`,
      );

      // Exchange GitHub token for Supabase session via Edge Function
      const response = await fetchWithTimeout(
        GITHUB_TOKEN_EXCHANGE_URL,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ github_token: githubSession.accessToken }),
        },
        DEFAULT_AUTH_EDGE_FUNCTION_TIMEOUT_MS,
        'Authentication server timeout. Please try again.',
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMsg =
          errorData.error || `Token exchange failed: ${response.status}`;
        logger.error(
          'SupabaseAuthProvider',
          `GitHub token exchange failed (${response.status}): ${errorMsg} [token type: ${tokenType}]`,
        );
        // Provide user-friendly error messages for common issues
        if (response.status === 401) {
          throw new Error(
            'GitHub token validation failed. Please try signing out of GitHub in VS Code and signing in again.',
          );
        }
        throw new Error(errorMsg);
      }

      const data = await parseTokenExchangeResponse(response, logger);
      const session = toStorableGitHubTokenExchangeSession(
        data,
        githubSession.account.label,
        DEFAULT_SESSION_EXPIRY_MS,
      );

      await this.storeSession(session, true);
      void vscode.window.showInformationMessage(
        `Signed in as ${session.account.label}`,
      );
      logger.info(
        'SupabaseAuthProvider',
        `VS Code GitHub auth successful for ${session.account.label}`,
      );

      return this.toVSCodeSession(session);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      void vscode.window.showErrorMessage(`Authentication failed: ${message}`);
      throw error;
    }
  }

  /**
   * Create session using traditional Supabase OAuth flow.
   * Used in desktop VS Code where OAuth callbacks work reliably.
   */
  private async createSessionViaSupabaseOAuth(
    provider: OAuthProvider,
  ): Promise<vscode.AuthenticationSession> {
    try {
      const supabase = SupabaseClient.getClient();
      const isWeb = this.isWebEnvironment();

      const oauthOptions = await this.buildOAuthOptions(isWeb);

      const { data, error } = await supabase.auth.signInWithOAuth({
        provider,
        options: oauthOptions,
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
          await this.storeSession(session, true);
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
      await this.sessionCoordinator.clearSession();
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
      throw new Error(AUTH_URI_HANDLER_NOT_INITIALIZED);
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
            const result =
              await this.sessionCoordinator.createSessionFromCallback({
                path: uri.path,
                query: uri.query,
                fragment: uri.fragment,
              });

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
