import * as vscode from 'vscode';
import { invalidateRemoteAgentsAfterSignOut } from '@agent/index';
import { refreshRemoteAgentCatalogAfterSignOut } from '@auth/authFlowEffects';
import { SupabaseClient } from '@auth/SupabaseClient';
import {
  AUTH_BRIDGE_URL,
  DEFAULT_OAUTH_PROVIDER,
  getExtensionId,
  getExternalAuthCallbackInfo,
  AUTH_CALLBACK_TIMEOUT_MS,
  isOAuthProvider,
  type OAuthProvider,
} from '@auth/config';
import { createHostAuthCoordinator } from '@auth/SupabaseAuthCoordinator';
import { getServerSideKeyService } from '@auth/serverKeys';
import {
  SupabaseSessionCoordinator,
  type SupabaseSession,
} from '@auth/SupabaseSession';
import { classifyAuthFailureStatus } from '@auth/TokenProvider';
import * as logger from '@logger/logUtils';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import { platform } from '@platform/platform';
import { toErrorMessage } from '@utils/errors/errorMessage';
import type { SupabaseUriHandler } from './UriHandler';

const CHANNEL = 'SupabaseAuthProvider';
const log = logger.createLog(CHANNEL);

const AUTH_URI_HANDLER_NOT_INITIALIZED =
  'OAuth handler not initialized. Restart the extension.';

/** Notification operations injected at construction so tests can stub them. */
export interface AuthNotifier {
  showError(message: string): void;
  showInfo(message: string): void;
  showSignInPrompt(reason: 'expired' | 'invalid'): Promise<void>;
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
  private readonly sessionCoordinator: SupabaseSessionCoordinator;
  /** Prevent concurrent callback handlers from storing competing sessions. */
  private isProcessingCallback = false;

  private readonly notifier: AuthNotifier;

  constructor(notifier: AuthNotifier) {
    this.notifier = notifier;
    this.sessionCoordinator = createHostAuthCoordinator({
      secrets: platform().secrets,
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
   * Store a newly created session and publish the credential change: clear the
   * caches that depend on the account and fire the session-change event.
   */
  private async storeSession(session: SupabaseSession): Promise<void> {
    await this.sessionCoordinator.storeSession(session);
    getServerSideKeyService().clearAllCaches({ resetQuotaFlip: true });
    invalidateModelOptionsCache();
    this._onDidChangeSessions.fire({
      added: [this.toVSCodeSession(session)],
      removed: [],
      changed: [],
    });
  }

  /**
   * Set URI handler for OAuth callbacks.
   * @param handler - The URI handler to use for auth callbacks
   */
  setUriHandler(handler: SupabaseUriHandler): void {
    // Dispose previous subscription if any
    this.uriHandlerSubscription?.dispose();

    this.uriHandler = handler;

    // Keep listening after an active sign-in wait ends so a late browser
    // callback can still complete while its PKCE verifier remains in memory.
    this.uriHandlerSubscription = handler.onDidReceiveCallback(async (uri) => {
      await this.handleLateAuthCallback(uri);
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
   * Handle a late PKCE auth callback URI.
   * This runs for all auth callbacks, but only processes if no session exists
   * and no OAuth flow is currently active.
   */
  private async handleLateAuthCallback(uri: vscode.Uri): Promise<void> {
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
      });

      if (!result.success) {
        if (result.isAuthError) {
          log.error(`Sign-in failed: ${result.error}`);
          this.notifier.showError(`Sign-in failed: ${result.error}`);
        } else {
          log.debug(`Auth callback ignored: ${result.error}`);
        }
        return;
      }

      await this.storeSession(result.session);
      this.notifier.showInfo(`Signed in as ${result.session.account.label}`);
      log.info(`Late sign-in successful for ${result.session.account.label}`);
    } catch (error) {
      log.error(`Error processing auth callback: ${toErrorMessage(error)}`);
      this.notifier.showError(`Sign-in failed: ${toErrorMessage(error)}`);
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

    try {
      if (Date.now() >= session.expiresAt) {
        const refreshed = await this.sessionCoordinator.refreshSession(session);
        if (!refreshed) {
          if (this.sessionCoordinator.getLastRefreshFailure() === 'invalid') {
            await this.handleInvalidSession(session, 'expired');
          }
          return [];
        }
        return [this.toVSCodeSession(refreshed)];
      }

      const { data, error } = await SupabaseClient.getClient().auth.getUser(
        session.accessToken,
      );
      if (error) {
        if (classifyAuthFailureStatus(error.status) === 'invalid') {
          await this.handleInvalidSession(session, 'invalid');
        }
        return [];
      }
      if (!data.user) {
        return [];
      }

      return [this.toVSCodeSession(session)];
    } catch (error) {
      log.error(`Error loading session: ${toErrorMessage(error)}`);
      return [];
    }
  }

  /**
   * Handle invalid session by removing it and prompting user to sign in again.
   */
  private async handleInvalidSession(
    session: SupabaseSession,
    reason: 'expired' | 'invalid',
  ): Promise<void> {
    // The rejected credential is already unusable. Do not call the client's
    // global signOut here: an OAuth callback may have installed a replacement
    // while validation was in flight, and signOut would target that newer
    // client state. The conditional local clear below is generation-safe.
    const cleared = await this.clearLocalSessionIfCurrent(session);
    if (cleared) {
      await this.notifier.showSignInPrompt(reason);
    }
  }

  private async buildOAuthOptions(): Promise<{ redirectTo: string }> {
    if (vscode.env.uiKind === vscode.UIKind.Web) {
      const callbackInfo = await getExternalAuthCallbackInfo();
      log.info(`OAuth callback URI (web): ${callbackInfo.fullUrl}`);
      // In Codespaces/web the tunnel routing token must ride on redirect_to
      // (fullUrl already carries ?state=TUNNEL). Passing it as queryParams.state
      // instead overwrites GoTrue's own OAuth state on /authorize, which makes
      // the callback fail with bad_oauth_state ("OAuth state not found or
      // expired"). With no tunnel state, fullUrl is just the bare callback URL,
      // so this is also correct for plain web.
      // PKCE flow: the callback carries a one-time ?code= (query), which the
      // shared createSessionFromCallback exchanges for a session.
      return { redirectTo: callbackInfo.fullUrl };
    }

    // Desktop: redirect GoTrue to the https bridge page instead of straight to
    // the raw vscode:// deep link, which Firefox on Linux drops (bad_oauth_state).
    // With PKCE the bridge only ever sees a one-time ?code= (no tokens); it
    // forwards that to ${scheme}://${id}/auth-callback for a real-click handoff.
    // ext/id ride in the PATH (not a query) so redirect_to carries no '?' that an
    // OAuth round-trip could mangle into the function name.
    const redirectTo =
      `${AUTH_BRIDGE_URL}/${encodeURIComponent(vscode.env.uriScheme)}` +
      `/${encodeURIComponent(getExtensionId())}`;
    log.info(`OAuth callback URI (desktop): ${redirectTo}`);
    return { redirectTo };
  }

  /**
   * Create authentication session via the Supabase OAuth flow, in the browser
   * with an environment-appropriate callback URI.
   *
   * @param scopes - Scopes array, may contain provider hint as "provider:github-browser" or "provider:google"
   */
  async createSession(
    scopes: readonly string[],
  ): Promise<vscode.AuthenticationSession> {
    const requestedProvider = scopes
      .find((s) => s.startsWith('provider:'))
      ?.split(':')[1];
    // 'github-browser' is the sign-in menu's name for GitHub OAuth handed off
    // to the system browser; it resolves to the same Supabase provider.
    const provider =
      requestedProvider === 'github-browser' ? 'github' : requestedProvider;

    return this.createSessionViaSupabaseOAuth(
      isOAuthProvider(provider) ? provider : DEFAULT_OAUTH_PROVIDER,
    );
  }

  /**
   * Open the provider's Supabase OAuth page in the browser and wait for the
   * callback. `buildOAuthOptions` picks the callback URI that works for the
   * current UI kind (desktop bridge page vs. web tunnel).
   */
  private async createSessionViaSupabaseOAuth(
    provider: OAuthProvider,
  ): Promise<vscode.AuthenticationSession> {
    try {
      const { data, error } =
        await SupabaseClient.getClient().auth.signInWithOAuth({
          provider,
          options: await this.buildOAuthOptions(),
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
          await this.storeSession(session);
        },
      );

      const sessions = await this.getSessions();
      if (sessions.length === 0) {
        throw new Error('Session creation failed. Try signing in again.');
      }
      return sessions[0];
    } catch (error) {
      this.notifier.showError(
        `Authentication failed: ${toErrorMessage(error)}`,
      );
      throw error;
    } finally {
      // Reset flag after entire OAuth flow completes (success or failure)
      this.isProcessingCallback = false;
    }
  }

  /**
   * Remove the authentication session. Sign-out clears local storage only,
   * matching the desktop and CLI hosts: the shared client never persists a
   * session of its own (its storage holds PKCE flow state only), so
   * `auth.signOut()` has no session of this provider's to revoke and would
   * target whatever session was last handed to the client, revoking every
   * device's refresh tokens with its default global scope.
   */
  async removeSession(sessionId: string): Promise<void> {
    await this.clearLocalSession(sessionId);
  }

  /**
   * Remove a stored session without first asking VS Code to resolve it.
   * Used for an already-invalid credential, where `getSessions()` would start
   * its own sign-in prompt and duplicate the caller's authentication action.
   */
  async clearStoredSession(): Promise<boolean> {
    const session = await this.sessionCoordinator.loadSession();
    if (!session) return false;
    if ((await this.sessionCoordinator.getStoredSessionState()) !== 'invalid') {
      return false;
    }
    return this.clearLocalSessionIfCurrent(session);
  }

  /** Remove the currently stored session without resolving it. */
  async removeStoredSession(): Promise<boolean> {
    const session = await this.sessionCoordinator.loadSession();
    if (!session) return false;
    await this.removeSession(session.id);
    return true;
  }

  private async clearLocalSession(sessionId: string): Promise<void> {
    await this.sessionCoordinator.clearSession();
    await this.afterLocalSessionCleared(sessionId);
  }

  private async clearLocalSessionIfCurrent(
    session: SupabaseSession,
  ): Promise<boolean> {
    const cleared =
      await this.sessionCoordinator.clearSessionIfCurrent(session);
    if (!cleared) return false;
    await this.afterLocalSessionCleared(session.id);
    return true;
  }

  private async afterLocalSessionCleared(sessionId: string): Promise<void> {
    getServerSideKeyService().clearAllCaches({ resetQuotaFlip: true });
    invalidateModelOptionsCache();
    await refreshRemoteAgentCatalogAfterSignOut(
      invalidateRemoteAgentsAfterSignOut,
      (message) => log.warn(message),
    );
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
  }

  /**
   * Wait for OAuth callback from URI handler.
   * Note: isProcessingCallback must be set by caller before invoking this method.
   * @param cancellationToken - Token to cancel the wait
   */
  private async waitForSession(
    cancellationToken: vscode.CancellationToken,
  ): Promise<SupabaseSession | null> {
    const uriHandler = this.uriHandler;
    if (!uriHandler) {
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
      const subscription = uriHandler.onDidReceiveCallback(async (uri) => {
        cleanupListeners();

        try {
          const result =
            await this.sessionCoordinator.createSessionFromCallback({
              path: uri.path,
              query: uri.query,
            });

          if (!result.success) {
            if (result.error === 'Missing authorization code in callback') {
              log.error(
                `Missing authorization code in OAuth callback. Has query: ${!!uri.query}`,
              );
            }
            reject(new Error(`OAuth error: ${result.error}. Try again.`));
            return;
          }

          resolve(result.session);
        } catch (error) {
          log.error(
            `Error processing OAuth callback: ${toErrorMessage(error)}`,
          );
          reject(error);
        }
      });

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
