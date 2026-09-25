import { Deferred, Effect, Exit } from 'effect';
import * as vscode from 'vscode';

import { invalidateRemoteAgentsAfterSignOut } from '@agent/index';
import { type AuthPortError, callPort, settleFailure } from '@auth/authProgram';
import {
  AUTH_BRIDGE_URL,
  DEFAULT_OAUTH_PROVIDER,
  getAuthCallbackUri,
  getExtensionId,
  isOAuthProvider,
  type OAuthProvider,
} from '@auth/config';
import type { SupabaseAuthShape } from '@auth/SupabaseAuth';
import type {
  SupabaseSession,
  SupabaseSessionCoordinator,
} from '@auth/SupabaseSession';
import { classifyAuthFailureStatus } from '@auth/TokenProvider';
import {
  PENDING_OAUTH_STATE_PREFIX,
  PendingOAuthStore,
  withCallbackNonce,
  type PendingOAuthSlots,
} from '@controllers/auth/pendingOAuthStore';
import {
  SupabaseSignInCoordinator,
  type AuthCallbackTransport,
  type SignInCallbackOutcome,
} from '@controllers/auth/supabaseSignIn';
import { withLogChannel } from '@logger/effectLog';
import type {
  AgentCatalogServices,
  ProcessRuntime,
} from '@platform/processRuntime';
import type { PlatformSecrets, SecretsFailed } from '@platform/secrets';
import { toErrorMessage } from '@utils/errors/errorMessage';
import type { SupabaseUriHandler } from './UriHandler';

const CHANNEL = 'SupabaseAuthProvider';

export const AUTH_URI_HANDLER_NOT_INITIALIZED =
  'OAuth handler not initialized. Restart the extension.';

/** Notification operations injected at construction so tests can stub them. */
interface AuthNotifier {
  showError(message: string): void;
  showInfo(message: string): void;
  showSignInPrompt(
    reason: 'expired' | 'invalid',
  ): Effect.Effect<void, AuthPortError>;
}

/**
 * The VS Code host's pending sign-in records: one secret per nonce, so a
 * callback delivered to a second window can claim the attempt the first one
 * started.
 */
function secretPendingOAuthSlots(secrets: PlatformSecrets): PendingOAuthSlots {
  const key = (nonce: string): string =>
    `${PENDING_OAUTH_STATE_PREFIX}${nonce}`;
  return {
    read: (nonce) => secrets.getStored(key(nonce)),
    write: (nonce, value) => secrets.set(key(nonce), value),
    erase: (nonce) => secrets.delete(key(nonce)),
    nonces: () =>
      Effect.map(secrets.listStoredKeys(), (stored) =>
        stored
          .filter((name) => name.startsWith(PENDING_OAUTH_STATE_PREFIX))
          .map((name) => name.slice(PENDING_OAUTH_STATE_PREFIX.length)),
      ),
  };
}

/**
 * Authentication provider for Supabase integration.
 *
 * VS Code plumbing only: the `vscode.AuthenticationProvider` contract, the
 * session-change event, and the editor's own callback transport. The sign-in
 * state machine — nonce, pending record, PKCE bind, claim, commit — is the
 * shared {@link SupabaseSignInCoordinator}.
 */
export class SupabaseAuthProvider implements vscode.AuthenticationProvider {
  private static instance: SupabaseAuthProvider | null = null;

  private _onDidChangeSessions =
    new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
  public readonly onDidChangeSessions = this._onDidChangeSessions.event;

  private uriHandler: SupabaseUriHandler | null = null;
  private uriHandlerSubscription: vscode.Disposable | null = null;
  private readonly sessionCoordinator: SupabaseSessionCoordinator;
  private readonly signIn: SupabaseSignInCoordinator;

  constructor(
    private readonly notifier: AuthNotifier,
    secrets: PlatformSecrets,
    private readonly runtime: ProcessRuntime,
    /**
     * The account plane the composition root built and served as
     * `SupabaseAuth`; the readiness gate it was built with is the extension
     * root's URI-handler check, flipped once `setUriHandler` runs.
     */
    private readonly auth: SupabaseAuthShape,
  ) {
    this.sessionCoordinator = auth.coordinator;
    this.signIn = new SupabaseSignInCoordinator({
      auth,
      store: new PendingOAuthStore(secretPendingOAuthSlots(secrets)),
      transport: this.transport(),
    });
    SupabaseAuthProvider.instance = this;
  }

  /** Get singleton instance for sign out operations. */
  static getInstance(): SupabaseAuthProvider | null {
    return this.instance;
  }

  /**
   * The editor's callback transport. The URI handler is registered for the
   * life of the extension and funnels every callback into the coordinator, so
   * a route needs no per-attempt subscription: a callback for a superseded
   * attempt, or one claimed by this window on another window's behalf, lands
   * the same way.
   */
  private transport(): AuthCallbackTransport {
    return {
      open: (route) =>
        callPort(() => {
          if (!this.uriHandler) {
            throw new Error(AUTH_URI_HANDLER_NOT_INITIALIZED);
          }
          return this.buildCallbackUrl(route.nonce);
        }),
      presentSignInUrl: (url) =>
        callPort(async () => {
          await vscode.env.openExternal(vscode.Uri.parse(url));
        }),
      announce: (outcome) =>
        Effect.sync(() => this.announceCallbackOutcome(outcome)),
    };
  }

  private announceCallbackOutcome(outcome: SignInCallbackOutcome): void {
    if (outcome.kind === 'committed') {
      this.notifier.showInfo(`Signed in as ${outcome.session.account.label}`);
      return;
    }
    if (outcome.kind === 'failed') {
      this.notifier.showError(`Sign-in failed: ${outcome.message}`);
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

    // One subscription for the life of the extension: an attempt's callback,
    // a superseded attempt's, and one belonging to another window all reach
    // the coordinator through it.
    this.uriHandlerSubscription = handler.onDidReceiveCallback((uri) => {
      this.runtime.runFork(
        Effect.flatMap(
          this.signIn.acceptCallback({ path: uri.path, query: uri.query }),
          (outcome) =>
            Effect.sync(() => {
              if (outcome.kind === 'committed') {
                this._onDidChangeSessions.fire({
                  added: [this.toVSCodeSession(outcome.session)],
                  removed: [],
                  changed: [],
                });
              }
            }),
        ),
      );
    });
  }

  /**
   * Dispose resources when provider is deactivated.
   */
  dispose(): void {
    this.runtime.runFork(this.signIn.cancel());
    this.uriHandlerSubscription?.dispose();
    this._onDidChangeSessions.dispose();
  }

  /** Get sessions from secure storage. */
  async getSessions(
    _scopes?: readonly string[],
    _options?: vscode.AuthenticationProviderSessionOptions,
  ): Promise<vscode.AuthenticationSession[]> {
    // The `vscode.AuthenticationProvider` contract owes VS Code a Promise, so
    // this is the R1(a) boundary that runs the program on the extension's
    // runtime; a failure reaches the editor as the port's own error.
    const exit = await this.runtime.runPromiseExit(this.loadUsableSessions());
    if (Exit.isSuccess(exit)) return exit.value;
    throw settleFailure(exit.cause);
  }

  /**
   * The list {@link getSessions} answers with, and the one the OAuth attempt
   * re-reads after its commit: a rejected load rejects the caller, a
   * resolution failure is reported and answered as an empty list.
   */
  private loadUsableSessions(): Effect.Effect<
    vscode.AuthenticationSession[],
    AuthPortError,
    AgentCatalogServices
  > {
    return Effect.gen({ self: this }, function* () {
      const session = yield* this.sessionCoordinator.loadSession();
      if (!session) {
        return [];
      }

      return yield* this.resolveUsableSession(session).pipe(
        Effect.catchCause((cause) =>
          Effect.logError(
            `Error loading session: ${toErrorMessage(settleFailure(cause))}`,
          ).pipe(
            withLogChannel(CHANNEL),
            Effect.as([] as vscode.AuthenticationSession[]),
          ),
        ),
      );
    });
  }

  /** Resolve a stored session to the session VS Code may use, if any. */
  private resolveUsableSession(
    session: SupabaseSession,
  ): Effect.Effect<
    vscode.AuthenticationSession[],
    AuthPortError,
    AgentCatalogServices
  > {
    return Effect.gen({ self: this }, function* () {
      if (Date.now() >= session.expiresAt) {
        const refreshed =
          yield* this.sessionCoordinator.refreshSession(session);
        if (!refreshed) {
          if (this.sessionCoordinator.getLastRefreshFailure() === 'invalid') {
            yield* this.handleInvalidSession(session, 'expired');
          }
          return [];
        }
        return [this.toVSCodeSession(refreshed)];
      }

      const { data, error } = yield* callPort(() =>
        this.auth.client.auth.getUser(session.accessToken),
      );
      if (error) {
        if (classifyAuthFailureStatus(error.status) === 'invalid') {
          yield* this.handleInvalidSession(session, 'invalid');
        }
        return [];
      }
      if (!data.user) return [];

      return [this.toVSCodeSession(session)];
    });
  }

  /**
   * Handle invalid session by removing it and prompting user to sign in again.
   */
  private handleInvalidSession(
    session: SupabaseSession,
    reason: 'expired' | 'invalid',
  ): Effect.Effect<void, AuthPortError, AgentCatalogServices> {
    return Effect.gen({ self: this }, function* () {
      // The rejected credential is already unusable. Do not call the client's
      // global signOut here: an OAuth callback may have installed a replacement
      // while validation was in flight, and signOut would target that newer
      // client state. The conditional local clear below is generation-safe.
      if (yield* this.clearLocalSessionIfCurrent(session)) {
        yield* this.notifier.showSignInPrompt(reason);
      }
    });
  }

  /**
   * The URL GoTrue redirects this attempt's callback to. `vscode.env.uiKind`
   * picks it: a web/Codespaces workbench routes through the editor's own
   * external URI, a desktop editor through the https bridge page.
   */
  private async buildCallbackUrl(nonce: string): Promise<string> {
    if (vscode.env.uiKind === vscode.UIKind.Web) {
      const externalUri = await vscode.env.asExternalUri(
        vscode.Uri.parse(getAuthCallbackUri(vscode.env.uriScheme)),
      );
      // asExternalUri adds a ?state= routing token in Codespaces; carrying it on
      // the redirect URL is what routes the callback back into the editor.
      // skipEncoding (toString(true)) so auth-js's encodeURIComponent over
      // redirectTo does not double-encode the already percent-encoded token;
      // double-encoding corrupts it and the callback never returns (silent
      // timeout).
      // In Codespaces/web the tunnel routing token must ride on redirect_to
      // (the URL already carries ?state=TUNNEL). Passing it as
      // queryParams.state instead overwrites GoTrue's own OAuth state on
      // /authorize, which makes the callback fail with bad_oauth_state ("OAuth
      // state not found or expired"). With no tunnel state this is just the
      // bare callback URL, so it is also correct for plain web.
      // PKCE flow: the callback carries a one-time ?code= (query), which the
      // shared coordinator exchanges for a session.
      return withCallbackNonce(externalUri.toString(true), nonce);
    }

    // Desktop: redirect GoTrue to the https bridge page instead of straight to
    // the raw vscode:// deep link, which Firefox on Linux drops (bad_oauth_state).
    // With PKCE the bridge only ever sees a one-time ?code= (no tokens); it
    // forwards that to ${scheme}://${id}/auth-callback for a real-click handoff.
    // ext/id/nonce ride in the PATH (not a query) so redirect_to carries no '?'
    // that an OAuth round-trip could mangle into the function name.
    return (
      `${AUTH_BRIDGE_URL}/${encodeURIComponent(vscode.env.uriScheme)}` +
      `/${encodeURIComponent(getExtensionId())}/${nonce}`
    );
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
   * Run one shared sign-in attempt inside the editor's cancellable progress
   * notification. The token's cancellation is the one host signal the shared
   * program cannot see for itself, so it races the attempt.
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
        progress.report({ message: 'Waiting for authentication...' });
        const cancelled = Deferred.makeUnsafe<never, Error>();
        const cancel = (): void => {
          Deferred.doneUnsafe(
            cancelled,
            Effect.fail(new Error('Authentication cancelled. Try again.')),
          );
        };
        const listener = token.onCancellationRequested(cancel);
        if (token.isCancellationRequested) cancel();

        const exit = await this.runtime.runPromiseExit(
          Effect.raceFirst(
            this.signIn.signIn({ provider }),
            Deferred.await(cancelled),
          ).pipe(
            // Resolve through the program `getSessions` answers with, so its
            // failure policy — a rejected load rejects the attempt, a
            // resolution failure answers an empty list — applies unchanged to
            // the post-commit read.
            Effect.andThen(this.loadUsableSessions()),
            Effect.flatMap((sessions) =>
              sessions.length === 0
                ? Effect.fail(
                    new Error('Session creation failed. Try signing in again.'),
                  )
                : Effect.succeed(sessions[0]),
            ),
            Effect.ensuring(Effect.sync(() => listener.dispose())),
            Effect.catchCause((cause) => {
              this.notifier.showError(
                `Authentication failed: ${toErrorMessage(settleFailure(cause))}`,
              );
              return Effect.failCause(cause);
            }),
          ),
        );
        if (Exit.isSuccess(exit)) return exit.value;
        throw settleFailure(exit.cause);
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
    const cancelPending = this.signIn.cancel();
    const exit = await this.runtime.runPromiseExit(
      cancelPending.pipe(Effect.andThen(this.clearLocalSession(sessionId))),
    );
    if (Exit.isFailure(exit)) throw settleFailure(exit.cause);
  }

  /**
   * Remove a stored session without first asking VS Code to resolve it.
   * Used for an already-invalid credential, where `getSessions()` would start
   * its own sign-in prompt and duplicate the caller's authentication action.
   */
  clearStoredSession(): Effect.Effect<
    boolean,
    AuthPortError,
    AgentCatalogServices
  > {
    return Effect.gen({ self: this }, function* () {
      const session = yield* this.sessionCoordinator.loadSession();
      if (!session) return false;
      const storedState =
        yield* this.sessionCoordinator.getStoredSessionState();
      if (storedState !== 'invalid') {
        return false;
      }
      return yield* this.clearLocalSessionIfCurrent(session);
    });
  }

  /**
   * Remove the currently stored session without resolving it. The active
   * attempt is invalidated by this call, not by the program it hands back, so
   * the invalidation cannot slip behind the caller's fiber scheduling.
   */
  removeStoredSession(): Effect.Effect<
    boolean,
    AuthPortError | SecretsFailed,
    AgentCatalogServices
  > {
    const cancelPending = this.signIn.cancel();
    return Effect.gen({ self: this }, function* () {
      yield* cancelPending;
      const session = yield* this.sessionCoordinator.loadSession();
      if (!session) return false;
      yield* this.clearLocalSession(session.id);
      return true;
    });
  }

  private clearLocalSession(
    sessionId: string,
  ): Effect.Effect<void, AuthPortError, AgentCatalogServices> {
    return Effect.gen({ self: this }, function* () {
      yield* this.sessionCoordinator.clearSession();
      yield* this.afterLocalSessionCleared(sessionId);
    });
  }

  private clearLocalSessionIfCurrent(
    session: SupabaseSession,
  ): Effect.Effect<boolean, AuthPortError, AgentCatalogServices> {
    return Effect.gen({ self: this }, function* () {
      const cleared =
        yield* this.sessionCoordinator.clearSessionIfCurrent(session);
      if (!cleared) return false;
      yield* this.afterLocalSessionCleared(session.id);
      return true;
    });
  }

  private afterLocalSessionCleared(
    sessionId: string,
  ): Effect.Effect<void, never, AgentCatalogServices> {
    return invalidateRemoteAgentsAfterSignOut().pipe(
      Effect.andThen(
        Effect.sync(() => {
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
        }),
      ),
    );
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
