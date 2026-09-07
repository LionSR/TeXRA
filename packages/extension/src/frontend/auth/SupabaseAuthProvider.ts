import { randomBytes } from 'node:crypto';

import { Cause, Deferred, Effect, Exit, Option, Result } from 'effect';
import * as vscode from 'vscode';
import { z } from 'zod';

import { invalidateRemoteAgentsAfterSignOut } from '@agent/index';
import { refreshRemoteAgentCatalogAfterSignOut } from '@auth/authFlowEffects';
import {
  AuthPortError,
  callPort,
  installAuthProgramEdge,
  runAuthProgram,
  SerializedWrites,
} from '@auth/authProgram';
import { withPkcePermit } from '@auth/pkcePermit';
import { SupabaseClient } from '@auth/SupabaseClient';
import {
  AUTH_BRIDGE_URL,
  DEFAULT_OAUTH_PROVIDER,
  getAuthCallbackUri,
  getExtensionId,
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
import { parseJsonWith } from '@common/parsing/safeParseJson';
import * as logger from '@logger/logUtils';
import { platform } from '@platform/platform';
import { effectRuntime } from '@platform/processRuntime';
import type { PlatformSecrets } from '@platform/secrets';
import { toErrorMessage } from '@utils/errors/errorMessage';
import type { HttpClient } from 'effect/unstable/http';
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
  private readonly secrets: PlatformSecrets;
  // The two p-queue serializers this class used to carry, as the auth
  // subsystem's own construct: commits serialize session storage writes (and
  // give `awaitIdle` as the drain barrier), claims serialize callback claims
  // so two windows cannot commit the same attempt.
  private readonly authCommits = new SerializedWrites();
  private readonly callbackClaims = new SerializedWrites();
  private activeAttempt: ExtensionAuthAttempt | undefined;

  constructor(private readonly notifier: AuthNotifier) {
    // The auth subsystem's run edge lives at this host entry (PRD R1): every
    // Promise-facing auth surface settles on the process runtime from here.
    installAuthProgramEdge((program) =>
      effectRuntime().runPromiseExit(program),
    );
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

  /**
   * Settle an auth effect at this host edge as an `Exit`, unwrapping the port
   * envelope from a typed failure so the fold sees the port's own error — the
   * same error the Promise edge surfaced to the converted catch clauses.
   */
  private async settleAuthEffect<A>(
    program: Effect.Effect<A, unknown, HttpClient.HttpClient>,
  ): Promise<Exit.Exit<A, unknown>> {
    const exit = await effectRuntime().runPromiseExit(program);
    if (Exit.isSuccess(exit)) return exit;
    return Exit.failCause(
      Cause.map(exit.cause, (error: unknown) =>
        error instanceof AuthPortError ? error.cause : error,
      ),
    );
  }

  private pendingStateKey(nonce: string): string {
    return `${PENDING_OAUTH_STATE_PREFIX}${nonce}`;
  }

  private async readPendingOAuthState(
    nonce: string,
  ): Promise<PendingOAuthState | null> {
    const stored = await this.secrets.getStored(this.pendingStateKey(nonce));
    if (!stored) return null;
    const parsed = parseJsonWith(stored, PendingOAuthStateSchema);
    if (Result.isSuccess(parsed)) return parsed.success;
    // The fixed diagnostic deliberately excludes stored secret content.
    log.warn('Stored OAuth callback state is malformed and will be ignored');
    return null;
  }

  private isPendingStateValid(state: PendingOAuthState): boolean {
    const age = Date.now() - state.createdAt;
    return age >= 0 && age <= AUTH_CALLBACK_TIMEOUT_MS;
  }

  private async sweepPendingOAuthStates(): Promise<void> {
    const listed = await this.settleAuthEffect(
      callPort(() => this.secrets.listStoredKeys()),
    );
    if (Exit.isFailure(listed)) {
      log.warn('Unable to inspect stored OAuth callback state for cleanup');
      return;
    }

    for (const key of listed.value) {
      if (!key.startsWith(PENDING_OAUTH_STATE_PREFIX)) continue;
      const nonce = key.slice(PENDING_OAUTH_STATE_PREFIX.length);
      const cleaned = await this.settleAuthEffect(
        Effect.gen({ self: this }, function* () {
          const state = yield* callPort(() =>
            this.readPendingOAuthState(nonce),
          );
          if (!state?.flowId || !this.isPendingStateValid(state)) {
            yield* callPort(() => this.secrets.delete(key));
          }
        }),
      );
      if (Exit.isFailure(cleaned)) {
        log.warn('Unable to clean up stored OAuth callback state');
      }
    }
  }

  private async bindPkceFlow(
    attempt: ExtensionAuthAttempt,
    flowId: string | null | undefined,
  ): Promise<void> {
    if (!flowId || !PKCE_FLOW_ID_PATTERN.test(flowId)) {
      throw new Error('OAuth initialization did not return a valid PKCE flow.');
    }
    if (!this.isPendingStateValid(attempt)) {
      throw new Error(
        'Authentication attempt is no longer pending. Try again.',
      );
    }
    await this.secrets.set(
      this.pendingStateKey(attempt.nonce),
      JSON.stringify({
        nonce: attempt.nonce,
        createdAt: attempt.createdAt,
        flowId,
      }),
    );
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

  /** Claim a persisted callback and hand back its PKCE flow id. */
  private async claimCallback(
    query: string,
    expectedAttempt?: ExtensionAuthAttempt,
  ): Promise<string | null> {
    return runAuthProgram(
      this.callbackClaims.run(
        Effect.gen({ self: this }, function* (): Generator<
          Effect.Effect<unknown, AuthPortError>,
          string | null,
          never
        > {
          const nonce = this.callbackNonce(query);
          if (!nonce || (expectedAttempt && expectedAttempt.nonce !== nonce)) {
            log.warn(
              'OAuth callback rejected: invalid or stale attempt binding',
            );
            return null;
          }

          const pending = yield* callPort(() =>
            this.readPendingOAuthState(nonce),
          );
          if (
            !pending?.flowId ||
            pending.nonce !== nonce ||
            !this.isPendingStateValid(pending)
          ) {
            if (pending && !this.isPendingStateValid(pending)) {
              yield* callPort(() => this.clearPendingAttempt(nonce));
            }
            log.warn(
              'OAuth callback rejected: invalid or stale attempt binding',
            );
            return null;
          }

          if (expectedAttempt && this.activeAttempt !== expectedAttempt) {
            log.debug(
              'OAuth callback ignored after its sign-in attempt was superseded',
            );
            return null;
          }

          yield* callPort(() => this.clearPendingAttempt(nonce));
          // Re-check after the await: `activeAttempt` is mutated outside the
          // claim lane by `invalidateActiveAttempt`, so this is not a repeat
          // of the check above.
          if (expectedAttempt && this.activeAttempt !== expectedAttempt) {
            return null;
          }
          return pending.flowId;
        }).pipe(
          // Any port failure means the callback's ownership could not be
          // verified; the fixed message deliberately excludes secret-store
          // detail, and the fold below re-throws exactly it.
          Effect.catch(() =>
            Effect.die(
              new Error(
                'OAuth callback state could not be verified. Try again.',
              ),
            ),
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

  private async cancelPendingAttempt(): Promise<void> {
    const pendingNonce = this.activeAttempt?.nonce;
    this.invalidateActiveAttempt();
    if (pendingNonce) await this.clearPendingAttempt(pendingNonce);
  }

  private async runAuthCommit<T>(commit: () => Promise<T>): Promise<T> {
    return runAuthProgram(this.authCommits.run(callPort(commit)));
  }

  /** Store a newly created session and fire the session-change event. */
  private async storeSession(session: SupabaseSession): Promise<void> {
    await runAuthProgram(this.sessionCoordinator.storeSession(session));
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

    const exit = await this.settleAuthEffect(
      callPort(() => this.processLateAuthCallback(uri)),
    );
    if (Exit.isFailure(exit)) {
      const message = toErrorMessage(Cause.squash(exit.cause));
      log.error(`Error processing auth callback: ${message}`);
      this.notifier.showError(`Sign-in failed: ${message}`);
    }
  }

  private async processLateAuthCallback(uri: vscode.Uri): Promise<void> {
    const flowId = await this.claimCallback(uri.query);
    if (!flowId) return;

    const existingSession = await runAuthProgram(
      this.sessionCoordinator.loadSession(),
    );
    if (existingSession) return;

    const result = await runAuthProgram(
      withPkcePermit(
        this.sessionCoordinator.createSessionFromCallback(
          { path: uri.path, query: uri.query },
          flowId,
        ),
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
      await this.storeSession(result.session);
      this.notifier.showInfo(`Signed in as ${result.session.account.label}`);
      log.info(`Late sign-in successful for ${result.session.account.label}`);
    });
  }

  /** Get sessions from secure storage. */
  async getSessions(
    _scopes?: readonly string[],
    _options?: vscode.AuthenticationProviderSessionOptions,
  ): Promise<vscode.AuthenticationSession[]> {
    const session = await runAuthProgram(this.sessionCoordinator.loadSession());
    if (!session) {
      return [];
    }

    const exit = await this.settleAuthEffect(
      callPort(() => this.resolveUsableSession(session)),
    );
    if (Exit.isSuccess(exit)) return exit.value;
    log.error(
      `Error loading session: ${toErrorMessage(Cause.squash(exit.cause))}`,
    );
    return [];
  }

  /** Resolve a stored session to the session VS Code may use, if any. */
  private async resolveUsableSession(
    session: SupabaseSession,
  ): Promise<vscode.AuthenticationSession[]> {
    if (Date.now() >= session.expiresAt) {
      const refreshed = await runAuthProgram(
        this.sessionCoordinator.refreshSession(session),
      );
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
        const callback = this.waitForSession(attempt, token);
        // The rejection is observed at `await callback` in `runOAuthAttempt`;
        // guard the window before that await so an early failure is not an
        // unhandled rejection.
        void callback.then(undefined, () => {});
        const interruptedError = () =>
          new Error(
            token.isCancellationRequested
              ? 'Authentication cancelled. Try again.'
              : 'Authentication attempt was superseded. Try again.',
          );

        const exit = await this.settleAuthEffect(
          callPort(() =>
            this.runOAuthAttempt(
              provider,
              attempt,
              progress,
              callback,
              interruptedError,
            ),
          ).pipe(Effect.ensuring(this.finalizeOAuthAttempt(attempt))),
        );
        if (Exit.isSuccess(exit)) return exit.value;

        const error = Cause.squash(exit.cause);
        this.notifier.showError(
          `Authentication failed: ${toErrorMessage(error)}`,
        );
        throw error;
      },
    );
  }

  /** One OAuth attempt's body: initialize the flow, wait, and commit. */
  private async runOAuthAttempt(
    provider: OAuthProvider,
    attempt: ExtensionAuthAttempt,
    progress: vscode.Progress<{
      message?: string | undefined;
      increment?: number | undefined;
    }>,
    callback: Promise<SupabaseSession | null>,
    interruptedError: () => Error,
  ): Promise<vscode.AuthenticationSession> {
    progress.report({ message: 'Waiting for authentication...' });
    // Finish any callback commit owned by the superseded attempt before
    // initializing this attempt's PKCE flow.
    await runAuthProgram(this.authCommits.awaitIdle());
    if (this.activeAttempt !== attempt) throw interruptedError();

    await this.sweepPendingOAuthStates();
    if (this.activeAttempt !== attempt) throw interruptedError();

    const options = await this.buildOAuthOptions(attempt.nonce);
    const { data, error } = await runAuthProgram(
      withPkcePermit(
        callPort(() =>
          SupabaseClient.getClient().auth.signInWithOAuth({
            provider,
            options,
          }),
        ),
      ),
    );

    if (error || !data.url) {
      throw new Error(
        `OAuth initialization failed: ${error?.message || 'Unknown error'}. Try again.`,
      );
    }
    if (this.activeAttempt !== attempt) throw interruptedError();
    await this.bindPkceFlow(attempt, data.flowId);

    // The callback listener is already armed before the browser can send a
    // fast redirect back to the extension host.
    await vscode.env.openExternal(vscode.Uri.parse(data.url));
    const session = await callback;
    if (!session) {
      throw new Error('Authentication cancelled or timed out. Try again.');
    }

    await this.runAuthCommit(async () => {
      if (this.activeAttempt !== attempt) return;
      await this.storeSession(session);
      if (this.activeAttempt !== attempt) {
        await runAuthProgram(
          this.sessionCoordinator.clearSessionIfCurrent(session),
        );
      }
    });
    if (this.activeAttempt !== attempt) throw interruptedError();

    const sessions = await this.getSessions();
    if (sessions.length === 0) {
      throw new Error('Session creation failed. Try signing in again.');
    }
    return sessions[0];
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
      yield* callPort(() => this.clearPendingAttempt(attempt.nonce)).pipe(
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
    await this.cancelPendingAttempt();
    await this.clearLocalSession(sessionId);
  }

  /**
   * Remove a stored session without first asking VS Code to resolve it.
   * Used for an already-invalid credential, where `getSessions()` would start
   * its own sign-in prompt and duplicate the caller's authentication action.
   */
  async clearStoredSession(): Promise<boolean> {
    const session = await runAuthProgram(this.sessionCoordinator.loadSession());
    if (!session) return false;
    const storedState = await runAuthProgram(
      this.sessionCoordinator.getStoredSessionState(),
    );
    if (storedState !== 'invalid') {
      return false;
    }
    return this.clearLocalSessionIfCurrent(session);
  }

  /** Remove the currently stored session without resolving it. */
  async removeStoredSession(): Promise<boolean> {
    await this.cancelPendingAttempt();
    const session = await runAuthProgram(this.sessionCoordinator.loadSession());
    if (!session) return false;
    await this.clearLocalSession(session.id);
    return true;
  }

  private async clearLocalSession(sessionId: string): Promise<void> {
    await runAuthProgram(this.sessionCoordinator.clearSession());
    await this.afterLocalSessionCleared(sessionId);
  }

  private async clearLocalSessionIfCurrent(
    session: SupabaseSession,
  ): Promise<boolean> {
    const cleared = await runAuthProgram(
      this.sessionCoordinator.clearSessionIfCurrent(session),
    );
    if (!cleared) return false;
    await this.afterLocalSessionCleared(session.id);
    return true;
  }

  private async afterLocalSessionCleared(sessionId: string): Promise<void> {
    await refreshRemoteAgentCatalogAfterSignOut(
      () => effectRuntime().runPromise(invalidateRemoteAgentsAfterSignOut()),
      log.warn,
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

    // The one settle slot every path completes — the callback's session (or
    // null on cancel), the timeout's failure, or a claim/exchange error.
    // Created before the wait's fiber starts so `attempt.cancel` is armed in
    // the same synchronous segment, as the Promise executor armed it.
    const outcome = Deferred.makeUnsafe<SupabaseSession | null, unknown>();
    // Timeout covers only the wait for a matching callback, as
    // `clearTimeout` did once `cleanupListeners` ran — not the token exchange.
    const callbackSeen = Deferred.makeUnsafe<void>();
    attempt.cancel = () => {
      if (this.activeAttempt === attempt) this.activeAttempt = undefined;
      Deferred.doneUnsafe(callbackSeen, Effect.void);
      Deferred.doneUnsafe(outcome, Effect.succeed(null));
    };

    const exit = await this.settleAuthEffect(
      Effect.scoped(
        Effect.gen({ self: this }, function* () {
          // The callback subscription and the cancellation listener are
          // scoped acquisitions: whichever path settles `outcome`, closing
          // the scope disposes both — what `cleanupListeners` did by hand.
          let subscription: vscode.Disposable | undefined;
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              subscription = uriHandler.onDidReceiveCallback((uri) => {
                effectRuntime().runFork(
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
                : Effect.fail(
                    new Error('Authentication timed out. Try again.'),
                  ),
            ),
          );
          return yield* Deferred.await(outcome);
        }),
      ),
    );
    if (Exit.isSuccess(exit)) return exit.value;
    throw Cause.squash(exit.cause);
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
      const flowId = yield* Effect.tryPromise({
        try: () => this.claimCallback(uri.query, attempt),
        catch: (error) => error,
      });
      if (!flowId) return;
      stopListening();

      const result = yield* Effect.tryPromise({
        try: () =>
          runAuthProgram(
            withPkcePermit(
              this.sessionCoordinator.createSessionFromCallback(
                { path: uri.path, query: uri.query },
                flowId,
              ),
            ),
          ),
        catch: (error) => error,
      });

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
      Effect.catch((error) =>
        Effect.sync(() => {
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
