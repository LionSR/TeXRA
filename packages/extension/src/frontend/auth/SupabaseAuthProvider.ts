import { randomBytes } from 'node:crypto';

import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Option,
  Result,
} from 'effect';
import * as vscode from 'vscode';

import { invalidateRemoteAgentsAfterSignOut } from '@agent/index';
import { refreshRemoteAgentCatalogAfterSignOut } from '@auth/authFlowEffects';
import {
  type AuthPortError,
  callPort,
  SerializedWrites,
  settleFailure,
} from '@auth/authProgram';
import {
  isPendingOAuthStateFresh,
  OAUTH_NONCE_PATTERN,
  PendingOAuthStateSchema,
  PKCE_FLOW_ID_PATTERN,
  type PendingOAuthState,
} from '@auth/pendingOAuthState';
import { withPkcePermit } from '@auth/pkcePermit';
import {
  AUTH_BRIDGE_URL,
  DEFAULT_OAUTH_PROVIDER,
  getAuthCallbackUri,
  getExtensionId,
  AUTH_CALLBACK_TIMEOUT_MS,
  isOAuthProvider,
  type OAuthProvider,
} from '@auth/config';
import type { SupabaseAuthShape } from '@auth/SupabaseAuth';
import {
  SupabaseSessionCoordinator,
  type SupabaseSession,
} from '@auth/SupabaseSession';
import { classifyAuthFailureStatus } from '@auth/TokenProvider';
import { parseJsonWith } from '@common/parsing/safeParseJson';
import * as logger from '@logger/logUtils';
import type { ProcessRuntime } from '@platform/processRuntime';
import type { GlobalStorageFs } from '@platform/rootedFs';
import type { PlatformSecrets, SecretsFailed } from '@platform/secrets';
import { toErrorMessage } from '@utils/errors/errorMessage';
import type { HttpClient } from 'effect/unstable/http';
import type { SupabaseUriHandler } from './UriHandler';

const CHANNEL = 'SupabaseAuthProvider';
const log = logger.createLog(CHANNEL);

export const AUTH_URI_HANDLER_NOT_INITIALIZED =
  'OAuth handler not initialized. Restart the extension.';
const PENDING_OAUTH_STATE_PREFIX = 'texra.extension.pendingOAuthState.';

interface ExtensionAuthAttempt {
  readonly nonce: string;
  readonly createdAt: number;
  cancel(): void;
}

/** Notification operations injected at construction so tests can stub them. */
interface AuthNotifier {
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
  // The two p-queue serializers this class used to carry, as the auth
  // subsystem's own construct: commits serialize session storage writes (and
  // give `awaitIdle` as the drain barrier), claims serialize callback claims
  // so two windows cannot commit the same attempt.
  private readonly authCommits = new SerializedWrites();
  private readonly callbackClaims = new SerializedWrites();
  private activeAttempt: ExtensionAuthAttempt | undefined;

  constructor(
    private readonly notifier: AuthNotifier,
    private readonly secrets: PlatformSecrets,
    private readonly runtime: ProcessRuntime,
    /**
     * The account plane the composition root built and served as
     * `SupabaseAuth`; the readiness gate it was built with is the extension
     * root's URI-handler check, flipped once `setUriHandler` runs.
     */
    private readonly auth: SupabaseAuthShape,
  ) {
    this.sessionCoordinator = auth.coordinator;
    SupabaseAuthProvider.instance = this;
  }

  /** Get singleton instance for sign out operations. */
  static getInstance(): SupabaseAuthProvider | null {
    return this.instance;
  }

  private pendingStateKey(nonce: string): string {
    return `${PENDING_OAUTH_STATE_PREFIX}${nonce}`;
  }

  private readPendingOAuthState(
    nonce: string,
  ): Effect.Effect<PendingOAuthState | null, SecretsFailed> {
    return this.secrets.getStored(this.pendingStateKey(nonce)).pipe(
      Effect.map((stored) => {
        if (!stored) return null;
        const parsed = parseJsonWith(stored, PendingOAuthStateSchema);
        if (Result.isSuccess(parsed)) return parsed.success;
        // The fixed diagnostic deliberately excludes stored secret content.
        log.warn(
          'Stored OAuth callback state is malformed and will be ignored',
        );
        return null;
      }),
    );
  }

  private sweepPendingOAuthStates(): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const listed = yield* Effect.exit(this.secrets.listStoredKeys());
      if (Exit.isFailure(listed)) {
        log.warn('Unable to inspect stored OAuth callback state for cleanup');
        return;
      }

      for (const key of listed.value) {
        if (!key.startsWith(PENDING_OAUTH_STATE_PREFIX)) continue;
        const nonce = key.slice(PENDING_OAUTH_STATE_PREFIX.length);
        const cleaned = yield* Effect.exit(
          Effect.gen({ self: this }, function* () {
            const state = yield* this.readPendingOAuthState(nonce);
            if (!state?.flowId || !isPendingOAuthStateFresh(state)) {
              yield* this.secrets.delete(key);
            }
          }),
        );
        if (Exit.isFailure(cleaned)) {
          log.warn('Unable to clean up stored OAuth callback state');
        }
      }
    });
  }

  private bindPkceFlow(
    attempt: ExtensionAuthAttempt,
    flowId: string | null | undefined,
  ): Effect.Effect<void, SecretsFailed> {
    if (!flowId || !PKCE_FLOW_ID_PATTERN.test(flowId)) {
      throw new Error('OAuth initialization did not return a valid PKCE flow.');
    }
    if (!isPendingOAuthStateFresh(attempt)) {
      throw new Error(
        'Authentication attempt is no longer pending. Try again.',
      );
    }
    return this.secrets.set(
      this.pendingStateKey(attempt.nonce),
      JSON.stringify({
        nonce: attempt.nonce,
        createdAt: attempt.createdAt,
        flowId,
      }),
    );
  }

  private clearPendingAttempt(
    nonce: string,
  ): Effect.Effect<void, SecretsFailed> {
    return this.secrets.delete(this.pendingStateKey(nonce));
  }

  private callbackNonce(query: string): string | null {
    const values = new URLSearchParams(query).getAll('app_nonce');
    if (values.length !== 1 || !OAUTH_NONCE_PATTERN.test(values[0])) {
      return null;
    }
    return values[0];
  }

  /** Claim a persisted callback and hand back its PKCE flow id. */
  private claimCallback(
    query: string,
    expectedAttempt?: ExtensionAuthAttempt,
  ): Effect.Effect<string | null> {
    return this.callbackClaims.run(
      Effect.gen({ self: this }, function* () {
        const nonce = this.callbackNonce(query);
        if (!nonce || (expectedAttempt && expectedAttempt.nonce !== nonce)) {
          log.warn('OAuth callback rejected: invalid or stale attempt binding');
          return null;
        }

        const pending = yield* this.readPendingOAuthState(nonce);
        if (
          !pending?.flowId ||
          pending.nonce !== nonce ||
          !isPendingOAuthStateFresh(pending)
        ) {
          if (pending && !isPendingOAuthStateFresh(pending)) {
            yield* this.clearPendingAttempt(nonce);
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

        yield* this.clearPendingAttempt(nonce);
        // Re-check after the yield: `activeAttempt` is mutated outside the
        // claim lane by `invalidateActiveAttempt`, so this is not a repeat
        // of the check above.
        if (expectedAttempt && this.activeAttempt !== expectedAttempt) {
          return null;
        }
        return pending.flowId;
      }).pipe(
        // Any port failure means the callback's ownership could not be
        // verified; the fixed message deliberately excludes secret-store
        // detail, and both callback surfaces fold the defect back to exactly
        // it.
        Effect.catch(() =>
          Effect.die(
            new Error('OAuth callback state could not be verified. Try again.'),
          ),
        ),
      ),
    );
  }

  private invalidateActiveAttempt(): void {
    const attempt = this.activeAttempt;
    this.activeAttempt = undefined;
    attempt?.cancel();
  }

  /**
   * Invalidate the active attempt synchronously and hand back the program
   * that clears its pending record, so a boundary can run the clear without
   * deferring the invalidation behind the runtime's scheduling.
   */
  private cancelPendingAttempt(): Effect.Effect<void, SecretsFailed> {
    const pendingNonce = this.activeAttempt?.nonce;
    this.invalidateActiveAttempt();
    return pendingNonce ? this.clearPendingAttempt(pendingNonce) : Effect.void;
  }

  /** Store a newly created session and fire the session-change event. */
  private storeSession(
    session: SupabaseSession,
  ): Effect.Effect<void, AuthPortError> {
    return Effect.gen({ self: this }, function* () {
      yield* this.sessionCoordinator.storeSession(session);
      this._onDidChangeSessions.fire({
        added: [this.toVSCodeSession(session)],
        removed: [],
        changed: [],
      });
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
    this.uriHandlerSubscription = handler.onDidReceiveCallback((uri) =>
      this.handleLateAuthCallback(uri),
    );
  }

  /**
   * Dispose resources when provider is deactivated.
   */
  dispose(): void {
    this.invalidateActiveAttempt();
    this.uriHandlerSubscription?.dispose();
    this._onDidChangeSessions.dispose();
  }

  /** Handle a persisted callback not owned by this window's active attempt. */
  private async handleLateAuthCallback(uri: vscode.Uri): Promise<void> {
    const nonce = this.callbackNonce(uri.query);
    if (nonce && this.activeAttempt?.nonce === nonce) return;

    await this.runtime.runPromise(
      this.processLateAuthCallback(uri).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            const message = toErrorMessage(settleFailure(cause));
            log.error(`Error processing auth callback: ${message}`);
            this.notifier.showError(`Sign-in failed: ${message}`);
          }),
        ),
      ),
    );
  }

  private processLateAuthCallback(
    uri: vscode.Uri,
  ): Effect.Effect<void, AuthPortError> {
    return Effect.gen({ self: this }, function* () {
      const flowId = yield* this.claimCallback(uri.query);
      if (!flowId) return;

      const existingSession = yield* this.sessionCoordinator.loadSession();
      if (existingSession) return;

      const result = yield* withPkcePermit(
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

      yield* this.authCommits.run(
        Effect.gen({ self: this }, function* () {
          yield* this.storeSession(result.session);
          this.notifier.showInfo(
            `Signed in as ${result.session.account.label}`,
          );
          log.info(
            `Late sign-in successful for ${result.session.account.label}`,
          );
        }),
      );
    });
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
    GlobalStorageFs | HttpClient.HttpClient | FileSystem.FileSystem
  > {
    return Effect.gen({ self: this }, function* () {
      const session = yield* this.sessionCoordinator.loadSession();
      if (!session) {
        return [];
      }

      return yield* this.resolveUsableSession(session).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            log.error(
              `Error loading session: ${toErrorMessage(settleFailure(cause))}`,
            );
            return [] as vscode.AuthenticationSession[];
          }),
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
    GlobalStorageFs | FileSystem.FileSystem
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
      if (!data.user) {
        return [];
      }

      return [this.toVSCodeSession(session)];
    });
  }

  /**
   * Handle invalid session by removing it and prompting user to sign in again.
   */
  private handleInvalidSession(
    session: SupabaseSession,
    reason: 'expired' | 'invalid',
  ): Effect.Effect<
    void,
    AuthPortError,
    GlobalStorageFs | FileSystem.FileSystem
  > {
    return Effect.gen({ self: this }, function* () {
      // The rejected credential is already unusable. Do not call the client's
      // global signOut here: an OAuth callback may have installed a replacement
      // while validation was in flight, and signOut would target that newer
      // client state. The conditional local clear below is generation-safe.
      const cleared = yield* this.clearLocalSessionIfCurrent(session);
      if (cleared) {
        yield* callPort(() => this.notifier.showSignInPrompt(reason));
      }
    });
  }

  private async buildOAuthOptions(
    nonce: string,
  ): Promise<{ redirectTo: string }> {
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
      const fullUrl = externalUri.toString(true);
      // In Codespaces/web the tunnel routing token must ride on redirect_to
      // (fullUrl already carries ?state=TUNNEL). Passing it as queryParams.state
      // instead overwrites GoTrue's own OAuth state on /authorize, which makes
      // the callback fail with bad_oauth_state ("OAuth state not found or
      // expired"). With no tunnel state, fullUrl is just the bare callback URL,
      // so this is also correct for plain web.
      // PKCE flow: the callback carries a one-time ?code= (query), which the
      // shared createSessionFromCallback exchanges for a session.
      const separator = fullUrl.includes('?') ? '&' : '?';
      return { redirectTo: `${fullUrl}${separator}app_nonce=${nonce}` };
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
          createdAt: Date.now(),
          cancel: () => {},
        };
        this.activeAttempt = attempt;
        const interruptedError = () =>
          new Error(
            token.isCancellationRequested
              ? 'Authentication cancelled. Try again.'
              : 'Authentication attempt was superseded. Try again.',
          );

        const exit = await this.runtime.runPromiseExit(
          this.runOAuthAttempt(
            provider,
            attempt,
            progress,
            token,
            interruptedError,
          ).pipe(
            Effect.ensuring(this.finalizeOAuthAttempt(attempt)),
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

  /** One OAuth attempt's body: initialize the flow, wait, and commit. */
  private runOAuthAttempt(
    provider: OAuthProvider,
    attempt: ExtensionAuthAttempt,
    progress: vscode.Progress<{
      message?: string | undefined;
      increment?: number | undefined;
    }>,
    cancellationToken: vscode.CancellationToken,
    interruptedError: () => Error,
  ): Effect.Effect<
    vscode.AuthenticationSession,
    unknown,
    GlobalStorageFs | HttpClient.HttpClient | FileSystem.FileSystem
  > {
    return Effect.scoped(
      Effect.gen({ self: this }, function* () {
        // Forked into the attempt's scope and started immediately, so the
        // callback listener is armed before anything else in the attempt runs
        // — a browser redirect cannot outrun it — and abandoning the attempt
        // interrupts the wait instead of leaving a settled result unobserved.
        const waiter = yield* Effect.forkScoped(
          this.waitForSession(attempt, cancellationToken),
          { startImmediately: true },
        );
        progress.report({ message: 'Waiting for authentication...' });
        // Finish any callback commit owned by the superseded attempt before
        // initializing this attempt's PKCE flow.
        yield* this.authCommits.awaitIdle();
        if (this.activeAttempt !== attempt) throw interruptedError();

        yield* this.sweepPendingOAuthStates();
        if (this.activeAttempt !== attempt) throw interruptedError();

        const options = yield* callPort(() =>
          this.buildOAuthOptions(attempt.nonce),
        );
        const { data, error } = yield* withPkcePermit(
          callPort(() =>
            this.auth.client.auth.signInWithOAuth({
              provider,
              options,
            }),
          ),
        );

        if (error || !data.url) {
          throw new Error(
            `OAuth initialization failed: ${error?.message || 'Unknown error'}. Try again.`,
          );
        }
        if (this.activeAttempt !== attempt) throw interruptedError();
        yield* this.bindPkceFlow(attempt, data.flowId);

        // The callback listener is already armed before the browser can send a
        // fast redirect back to the extension host.
        yield* callPort(async () => {
          await vscode.env.openExternal(vscode.Uri.parse(data.url));
        });
        const session = yield* Fiber.join(waiter);
        if (!session) {
          throw new Error('Authentication cancelled or timed out. Try again.');
        }

        yield* this.authCommits.run(
          Effect.gen({ self: this }, function* () {
            if (this.activeAttempt !== attempt) return;
            yield* this.storeSession(session);
            if (this.activeAttempt !== attempt) {
              yield* this.sessionCoordinator.clearSessionIfCurrent(session);
            }
          }),
        );
        if (this.activeAttempt !== attempt) throw interruptedError();

        // Resolve through the program `getSessions` answers with, so its
        // failure policy — a rejected load rejects the attempt, a resolution
        // failure answers an empty list — applies unchanged to the
        // post-commit read.
        const sessions = yield* this.loadUsableSessions();
        if (sessions.length === 0) {
          throw new Error('Session creation failed. Try signing in again.');
        }
        return sessions[0];
      }),
    );
  }

  /**
   * Every exit of an OAuth attempt: cancel the callback wait, drop the
   * attempt if it is still owned, and best-effort clear its pending record.
   * Attached with `ensuring`, so it runs on success, failure, and
   * interruption alike — the old `finally`.
   */
  private finalizeOAuthAttempt(
    attempt: ExtensionAuthAttempt,
  ): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      yield* Effect.sync(() => {
        attempt.cancel();
        if (this.activeAttempt === attempt) this.activeAttempt = undefined;
      });
      yield* this.clearPendingAttempt(attempt.nonce).pipe(
        Effect.catch(() =>
          Effect.sync(() => {
            log.warn('Unable to clean up stored OAuth callback state');
          }),
        ),
      );
    });
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
    const cancelPending = this.cancelPendingAttempt();
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
    GlobalStorageFs | FileSystem.FileSystem
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
    GlobalStorageFs | FileSystem.FileSystem
  > {
    const cancelPending = this.cancelPendingAttempt();
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
  ): Effect.Effect<
    void,
    AuthPortError,
    GlobalStorageFs | FileSystem.FileSystem
  > {
    return Effect.gen({ self: this }, function* () {
      yield* this.sessionCoordinator.clearSession();
      yield* this.afterLocalSessionCleared(sessionId);
    });
  }

  private clearLocalSessionIfCurrent(
    session: SupabaseSession,
  ): Effect.Effect<
    boolean,
    AuthPortError,
    GlobalStorageFs | FileSystem.FileSystem
  > {
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
  ): Effect.Effect<void, never, GlobalStorageFs | FileSystem.FileSystem> {
    return refreshRemoteAgentCatalogAfterSignOut(
      invalidateRemoteAgentsAfterSignOut(),
      log.warn,
    ).pipe(
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

  /** Wait for the callback owned by one OAuth attempt. */
  private waitForSession(
    attempt: ExtensionAuthAttempt,
    cancellationToken: vscode.CancellationToken,
  ): Effect.Effect<SupabaseSession | null, unknown> {
    return Effect.scoped(
      Effect.gen({ self: this }, function* () {
        const uriHandler = this.uriHandler;
        if (!uriHandler) {
          throw new Error(AUTH_URI_HANDLER_NOT_INITIALIZED);
        }

        // The one settle slot every path completes — the callback's session
        // (or null on cancel), the timeout's failure, or a claim/exchange
        // error. Created before the wait suspends so `attempt.cancel` is
        // armed in this fiber's first synchronous segment, which the forking
        // caller starts immediately.
        const outcome = Deferred.makeUnsafe<SupabaseSession | null, unknown>();
        // Timeout covers only the wait for a matching callback, as
        // `clearTimeout` did once `cleanupListeners` ran — not the token
        // exchange.
        const callbackSeen = Deferred.makeUnsafe<void>();
        attempt.cancel = () => {
          if (this.activeAttempt === attempt) this.activeAttempt = undefined;
          Deferred.doneUnsafe(callbackSeen, Effect.void);
          Deferred.doneUnsafe(outcome, Effect.succeed(null));
        };

        // The callback subscription and the cancellation listener are scoped
        // acquisitions: whichever path settles `outcome`, closing the scope
        // disposes both — what `cleanupListeners` did by hand.
        let subscription: vscode.Disposable | undefined;
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            subscription = uriHandler.onDidReceiveCallback((uri) => {
              this.runtime.runFork(
                this.handleAttemptCallback(uri, attempt, outcome, () => {
                  subscription?.dispose();
                  Deferred.doneUnsafe(callbackSeen, Effect.void);
                }),
              );
            });
            return subscription;
          }),
          (disposed) => Effect.sync(() => disposed.dispose()),
        );

        const cancel = () => attempt.cancel();
        if (cancellationToken.isCancellationRequested) {
          cancel();
        } else {
          yield* Effect.acquireRelease(
            Effect.sync(() =>
              cancellationToken.onCancellationRequested(cancel),
            ),
            (listener) => Effect.sync(() => listener.dispose()),
          );
        }

        yield* Deferred.await(callbackSeen).pipe(
          Effect.timeoutOption(AUTH_CALLBACK_TIMEOUT_MS),
          Effect.flatMap((settled) =>
            Option.isSome(settled)
              ? Effect.void
              : Effect.fail(new Error('Authentication timed out. Try again.')),
          ),
        );
        return yield* Deferred.await(outcome);
      }),
    );
  }

  /**
   * One callback event for `attempt`: claim its persisted state, stop
   * listening, and complete `outcome` with the exchange result. A claim that
   * matches nothing leaves the wait listening.
   */
  private handleAttemptCallback(
    uri: vscode.Uri,
    attempt: ExtensionAuthAttempt,
    outcome: Deferred.Deferred<SupabaseSession | null, unknown>,
    stopListening: () => void,
  ): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      const flowId = yield* this.claimCallback(uri.query, attempt);
      if (!flowId) return;
      stopListening();

      const result = yield* withPkcePermit(
        this.sessionCoordinator.createSessionFromCallback(
          { path: uri.path, query: uri.query },
          flowId,
        ),
      );

      if (!result.success) {
        if (result.error === 'Missing authorization code in callback') {
          log.error(
            `Missing authorization code in OAuth callback. Has query: ${!!uri.query}`,
          );
        }
        yield* Deferred.fail(
          outcome,
          new Error(`OAuth error: ${result.error}. Try again.`),
        );
        return;
      }

      if (this.activeAttempt !== attempt) {
        yield* Deferred.succeed(outcome, null);
        return;
      }
      yield* Deferred.succeed(outcome, result.session);
    }).pipe(
      // catchCause so the claim lane's defect ("callback state could not be
      // verified") and a port failure both settle `outcome`; settleFailure
      // keeps the port's own error as the value, as the Promise edge did.
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          const error = settleFailure(cause);
          log.error(
            `Error processing OAuth callback: ${toErrorMessage(error)}`,
          );
          Deferred.doneUnsafe(outcome, Effect.fail(error));
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
