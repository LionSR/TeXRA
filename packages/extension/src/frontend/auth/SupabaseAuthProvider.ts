import { randomBytes } from 'node:crypto';

import PQueue from 'p-queue';
import * as vscode from 'vscode';
import { z } from 'zod';

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
import {
  SupabaseSessionCoordinator,
  type SupabaseSession,
} from '@auth/SupabaseSession';
import { classifyAuthFailureStatus } from '@auth/TokenProvider';
import * as logger from '@logger/logUtils';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import { platform } from '@platform/platform';
import type { PlatformSecrets } from '@platform/secrets';
import { toErrorMessage } from '@utils/errors/errorMessage';
import type { SupabaseUriHandler } from './UriHandler';

const CHANNEL = 'SupabaseAuthProvider';
const log = logger.createLog(CHANNEL);

const AUTH_URI_HANDLER_NOT_INITIALIZED =
  'OAuth handler not initialized. Restart the extension.';
const OAUTH_NONCE_PATTERN = /^[0-9a-f]{32}$/;
const PKCE_FLOW_ID_PATTERN = /^[a-zA-Z0-9_-]{8,64}$/;
const PENDING_OAUTH_STATE_PREFIX = 'texra.extension.pendingOAuthState.';

const PendingOAuthStateSchema = z.strictObject({
  nonce: z.string().regex(OAUTH_NONCE_PATTERN),
  createdAt: z.number().finite(),
  flowId: z.string().regex(PKCE_FLOW_ID_PATTERN).optional(),
});
type PendingOAuthState = z.infer<typeof PendingOAuthStateSchema>;

interface ExtensionAuthAttempt {
  readonly nonce: string;
  cancel(): void;
}

interface ClaimedAuthCallback {
  attempt: ExtensionAuthAttempt;
  flowId: string;
}

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
  private readonly secrets: PlatformSecrets;
  private readonly authCommitQueue = new PQueue({ concurrency: 1 });
  private activeAttempt: ExtensionAuthAttempt | undefined;

  private readonly notifier: AuthNotifier;

  constructor(notifier: AuthNotifier) {
    this.notifier = notifier;
    const hostPlatform = platform();
    this.secrets = hostPlatform.secrets;
    this.sessionCoordinator = createHostAuthCoordinator({
      secrets: hostPlatform.secrets,
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

  private pendingStateKey(nonce: string): string {
    return `${PENDING_OAUTH_STATE_PREFIX}${nonce}`;
  }

  private async readPendingOAuthState(
    nonce: string,
  ): Promise<PendingOAuthState | null> {
    const stored = await this.secrets.getStored(this.pendingStateKey(nonce));
    if (!stored) return null;
    try {
      const parsed = PendingOAuthStateSchema.safeParse(JSON.parse(stored));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  private isPendingStateValid(state: PendingOAuthState): boolean {
    const age = Date.now() - state.createdAt;
    return age >= 0 && age <= AUTH_CALLBACK_TIMEOUT_MS;
  }

  private async persistPendingState(state: PendingOAuthState): Promise<void> {
    await this.secrets.set(
      this.pendingStateKey(state.nonce),
      JSON.stringify(state),
    );
  }

  private async beginAuthAttempt(attempt: ExtensionAuthAttempt): Promise<void> {
    await this.persistPendingState({
      nonce: attempt.nonce,
      createdAt: Date.now(),
    });
  }

  private async bindPkceFlow(
    nonce: string,
    flowId: string | null | undefined,
  ): Promise<void> {
    if (!flowId || !PKCE_FLOW_ID_PATTERN.test(flowId)) {
      throw new Error('OAuth initialization did not return a valid PKCE flow.');
    }
    const pending = await this.readPendingOAuthState(nonce);
    if (!pending || !this.isPendingStateValid(pending)) {
      throw new Error(
        'Authentication attempt is no longer pending. Try again.',
      );
    }
    await this.persistPendingState({ ...pending, flowId });
  }

  private async clearPendingAttempt(nonce: string): Promise<void> {
    await this.secrets.delete(this.pendingStateKey(nonce));
  }

  private callbackNonce(query: string): string | null {
    const values = new URLSearchParams(query).getAll('app_nonce');
    if (values.length !== 1 || !OAUTH_NONCE_PATTERN.test(values[0])) {
      return null;
    }
    return values[0];
  }

  private async claimCallback(
    query: string,
    expectedAttempt?: ExtensionAuthAttempt,
  ): Promise<ClaimedAuthCallback | null> {
    const nonce = this.callbackNonce(query);
    if (!nonce || (expectedAttempt && expectedAttempt.nonce !== nonce)) {
      log.warn('OAuth callback rejected: invalid or stale attempt binding');
      return null;
    }

    const pending = await this.readPendingOAuthState(nonce);
    if (
      !pending ||
      !pending.flowId ||
      pending.nonce !== nonce ||
      !this.isPendingStateValid(pending)
    ) {
      if (pending && !this.isPendingStateValid(pending)) {
        await this.clearPendingAttempt(nonce);
      }
      log.warn('OAuth callback rejected: invalid or stale attempt binding');
      return null;
    }

    if (expectedAttempt && this.activeAttempt !== expectedAttempt) {
      log.debug(
        'OAuth callback ignored after its sign-in attempt was superseded',
      );
      return null;
    }

    const attempt = expectedAttempt ?? {
      nonce,
      cancel: () => {},
    };
    if (!expectedAttempt) {
      if (this.activeAttempt) {
        log.debug('OAuth callback ignored while another sign-in is active');
        return null;
      }
      this.activeAttempt = attempt;
    }

    await this.clearPendingAttempt(nonce);
    if (this.activeAttempt !== attempt) return null;
    return { attempt, flowId: pending.flowId };
  }

  private invalidateActiveAttempt(): void {
    const attempt = this.activeAttempt;
    this.activeAttempt = undefined;
    attempt?.cancel();
  }

  private async cancelPendingAttempt(): Promise<void> {
    const pendingNonce = this.activeAttempt?.nonce;
    this.invalidateActiveAttempt();
    if (pendingNonce) await this.clearPendingAttempt(pendingNonce);
  }

  private async runAuthCommit<T>(commit: () => Promise<T>): Promise<T> {
    return this.authCommitQueue.add(commit) as Promise<T>;
  }

  /**
   * Store a newly created session and publish the credential change: clear the
   * caches that depend on the account and fire the session-change event.
   */
  private async storeSession(session: SupabaseSession): Promise<void> {
    await this.sessionCoordinator.storeSession(session);
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
    this.invalidateActiveAttempt();
    this.uriHandlerSubscription?.dispose();
    this._onDidChangeSessions.dispose();
  }

  /**
   * Handle a late PKCE auth callback URI.
   * This runs for all auth callbacks, but only processes if no session exists
   * and no OAuth flow is currently active.
   */
  private async handleLateAuthCallback(uri: vscode.Uri): Promise<void> {
    // The active attempt owns its callback through waitForSession. This listener
    // exists only for a callback that arrives after extension-host restart.
    if (this.activeAttempt) return;

    const claimed = await this.claimCallback(uri.query);
    if (!claimed) return;
    const { attempt, flowId } = claimed;

    try {
      const existingSession = await this.sessionCoordinator.loadSession();
      if (existingSession || this.activeAttempt !== attempt) return;

      const result = await SupabaseClient.runPkceOperation(() =>
        this.sessionCoordinator.createSessionFromCallback(
          { path: uri.path, query: uri.query },
          flowId,
        ),
      );

      if (!result.success) {
        if (result.isAuthError) {
          log.error(`Sign-in failed: ${result.error}`);
          this.notifier.showError(`Sign-in failed: ${result.error}`);
        } else {
          log.debug(`Auth callback ignored: ${result.error}`);
        }
        return;
      }

      await this.runAuthCommit(async () => {
        if (this.activeAttempt !== attempt) return;
        await this.storeSession(result.session);
        if (this.activeAttempt !== attempt) {
          await this.sessionCoordinator.clearSessionIfCurrent(result.session);
          return;
        }
        this.notifier.showInfo(`Signed in as ${result.session.account.label}`);
        log.info(`Late sign-in successful for ${result.session.account.label}`);
      });
    } catch (error) {
      log.error(`Error processing auth callback: ${toErrorMessage(error)}`);
      this.notifier.showError(`Sign-in failed: ${toErrorMessage(error)}`);
    } finally {
      if (this.activeAttempt === attempt) this.activeAttempt = undefined;
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

  private async buildOAuthOptions(
    nonce: string,
  ): Promise<{ redirectTo: string }> {
    if (vscode.env.uiKind === vscode.UIKind.Web) {
      const callbackInfo = await getExternalAuthCallbackInfo();
      // In Codespaces/web the tunnel routing token must ride on redirect_to
      // (fullUrl already carries ?state=TUNNEL). Passing it as queryParams.state
      // instead overwrites GoTrue's own OAuth state on /authorize, which makes
      // the callback fail with bad_oauth_state ("OAuth state not found or
      // expired"). With no tunnel state, fullUrl is just the bare callback URL,
      // so this is also correct for plain web.
      // PKCE flow: the callback carries a one-time ?code= (query), which the
      // shared createSessionFromCallback exchanges for a session.
      const separator = callbackInfo.fullUrl.includes('?') ? '&' : '?';
      return {
        redirectTo: `${callbackInfo.fullUrl}${separator}app_nonce=${nonce}`,
      };
    }

    // Desktop: redirect GoTrue to the https bridge page instead of straight to
    // the raw vscode:// deep link, which Firefox on Linux drops (bad_oauth_state).
    // With PKCE the bridge only ever sees a one-time ?code= (no tokens); it
    // forwards that to ${scheme}://${id}/auth-callback for a real-click handoff.
    // ext/id/nonce ride in the PATH (not a query) so redirect_to carries no '?'
    // that an OAuth round-trip could mangle into the function name.
    const redirectTo =
      `${AUTH_BRIDGE_URL}/${encodeURIComponent(vscode.env.uriScheme)}` +
      `/${encodeURIComponent(getExtensionId())}/${nonce}`;
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
    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'TeXRA Authentication',
        cancellable: true,
      },
      async (progress, token) => {
        this.invalidateActiveAttempt();
        const attempt: ExtensionAuthAttempt = {
          nonce: randomBytes(16).toString('hex'),
          cancel: () => {},
        };
        this.activeAttempt = attempt;
        const callback = this.waitForSession(attempt, token);

        try {
          progress.report({ message: 'Waiting for authentication...' });
          // Finish any callback commit owned by the superseded attempt before
          // publishing this attempt's pending state.
          await this.runAuthCommit(async () => {});
          if (this.activeAttempt !== attempt) {
            throw new Error(
              'Authentication attempt was superseded. Try again.',
            );
          }

          await this.beginAuthAttempt(attempt);
          if (this.activeAttempt !== attempt) {
            throw new Error(
              'Authentication attempt was superseded. Try again.',
            );
          }

          const options = await this.buildOAuthOptions(attempt.nonce);
          const { data, error } = await SupabaseClient.runPkceOperation(() =>
            SupabaseClient.getClient().auth.signInWithOAuth({
              provider,
              options,
            }),
          );

          if (error || !data.url) {
            throw new Error(
              `OAuth initialization failed: ${error?.message || 'Unknown error'}. Try again.`,
            );
          }
          if (this.activeAttempt !== attempt) {
            throw new Error(
              'Authentication attempt was superseded. Try again.',
            );
          }
          await this.bindPkceFlow(attempt.nonce, data.flowId);

          // The callback listener is already armed before the browser can send a
          // fast redirect back to the extension host.
          await vscode.env.openExternal(vscode.Uri.parse(data.url));
          const session = await callback;
          if (!session) {
            throw new Error(
              'Authentication cancelled or timed out. Try again.',
            );
          }

          await this.runAuthCommit(async () => {
            if (this.activeAttempt !== attempt) return;
            await this.storeSession(session);
            if (this.activeAttempt !== attempt) {
              await this.sessionCoordinator.clearSessionIfCurrent(session);
            }
          });
          if (this.activeAttempt !== attempt) {
            throw new Error(
              'Authentication attempt was superseded. Try again.',
            );
          }

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
          attempt.cancel();
          if (this.activeAttempt === attempt) this.activeAttempt = undefined;
          await this.clearPendingAttempt(attempt.nonce);
        }
      },
    );
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
    await this.cancelPendingAttempt();
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
    await this.cancelPendingAttempt();
    const session = await this.sessionCoordinator.loadSession();
    if (!session) return false;
    await this.clearLocalSession(session.id);
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

  /** Wait for the callback owned by one OAuth attempt. */
  private async waitForSession(
    attempt: ExtensionAuthAttempt,
    cancellationToken: vscode.CancellationToken,
  ): Promise<SupabaseSession | null> {
    const uriHandler = this.uriHandler;
    if (!uriHandler) {
      throw new Error(AUTH_URI_HANDLER_NOT_INITIALIZED);
    }

    return new Promise((resolve, reject) => {
      let isCleanedUp = false;
      const cancellationListeners: vscode.Disposable[] = [];

      const cleanupListeners = () => {
        if (isCleanedUp) return;
        isCleanedUp = true;
        clearTimeout(timeoutHandle);
        subscription.dispose();
        for (const listener of cancellationListeners) listener.dispose();
      };
      const cancel = () => {
        cleanupListeners();
        if (this.activeAttempt === attempt) this.activeAttempt = undefined;
        resolve(null);
      };
      attempt.cancel = cancel;

      const subscription = uriHandler.onDidReceiveCallback(async (uri) => {
        try {
          const claimed = await this.claimCallback(uri.query, attempt);
          if (!claimed) return;
          cleanupListeners();

          const result = await SupabaseClient.runPkceOperation(() =>
            this.sessionCoordinator.createSessionFromCallback(
              { path: uri.path, query: uri.query },
              claimed.flowId,
            ),
          );

          if (!result.success) {
            if (result.error === 'Missing authorization code in callback') {
              log.error(
                `Missing authorization code in OAuth callback. Has query: ${!!uri.query}`,
              );
            }
            reject(new Error(`OAuth error: ${result.error}. Try again.`));
            return;
          }

          if (this.activeAttempt !== attempt) {
            resolve(null);
            return;
          }
          resolve(result.session);
        } catch (error) {
          cleanupListeners();
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
        cancel();
        return;
      }

      const listener = cancellationToken.onCancellationRequested(cancel);
      if (isCleanedUp) listener.dispose();
      else cancellationListeners.push(listener);
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
