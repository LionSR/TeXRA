import { randomBytes } from 'node:crypto';

import { Cause, Deferred, Effect, Exit, Option } from 'effect';

import { invalidateRemoteAgentsAfterSignOut } from '@agent/index';
import {
  installAuthProgramEdge,
  settleFailure,
  type AuthPortError,
} from '@auth/authProgram';
import {
  AUTH_CALLBACK_TIMEOUT_MS,
  DEFAULT_OAUTH_PROVIDER,
  getAuthCallbackUri,
  type OAuthProvider,
} from '@auth/config';
import {
  isPendingOAuthStateFresh,
  PendingOAuthStateSchema,
  type PendingOAuthState,
} from '@auth/pendingOAuthState';
import {
  refreshRemoteAgentCatalogAfterSignOut,
  requireOAuthRedirectUrl,
} from '@auth/authFlowEffects';
import type { SupabaseAuthShape } from '@auth/SupabaseAuth';
import {
  type SupabaseCallbackResult,
  type SupabaseSession,
  type SupabaseSessionLog,
} from '@auth/SupabaseSession';
import type { AuthCallbackUriParts } from '@auth/authCallback';
import type { MessageHost } from '@hosts/uiHosts';
import type { StateStore, StateWriteFailed } from '@platform/interfaces';
import type { ProcessRuntime } from '@platform/processRuntime';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { withPerKeyLane, type PerKeyLane } from '@utils/core/perKeyQueue';
import { TEXRA_PROTOCOL } from '../shared/desktopProtocol.js';
import type {
  DesktopProtocolCallback,
  DesktopProtocolCallbackRouter,
} from './desktopProtocolCallbacks.js';

const DESKTOP_PENDING_OAUTH_STATE_KEY = 'texra.desktop.pendingOAuthState';

// Lane keys for the serialized auth work below: pending-state persists,
// session commits, and protocol callbacks each run on their own exclusive
// lane.
const AUTH_PERSIST_LANE = 'persist';
const AUTH_COMMIT_LANE = 'commit';
const AUTH_CALLBACK_LANE = 'callback';

interface DesktopSupabaseAuth {
  signIn(provider?: OAuthProvider): Promise<void>;
  signInAndWaitForSession(
    provider?: OAuthProvider,
    options?: { timeoutMs?: number },
  ): Promise<boolean>;
  signOut(): Promise<void>;
  dispose(): void;
}

export interface DesktopAuthCallbackState {
  hasPendingSignIn(): boolean;
  beginAuthAttempt(nonce: string): Effect.Effect<void, StateWriteFailed>;
  /**
   * True only when a sign-in is pending AND its stored nonce equals `nonce`.
   * Binds an inbound callback to the attempt THIS client started, so a verified
   * but foreign-account token deeplink can't complete a sign-in (login-CSRF).
   */
  matchesPendingNonce(nonce: string | undefined): boolean;
  clearAwaitingCallback(nonce?: string): Effect.Effect<void, StateWriteFailed>;
}

export type DesktopAuthLog = Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;

export interface DesktopSupabaseAuthHost extends Pick<
  MessageHost,
  'showInfoMessage' | 'showErrorMessage'
> {
  /** The window's shell-facing `openExternal`, with its own "could not open"
   *  dialog suppressed: this flow words a missing browser itself. */
  openExternalUrl(url: string): Effect.Effect<void, unknown>;
  onSessionChanged(): Promise<void> | void;
}

interface DesktopSupabaseAuthOptions {
  router: DesktopProtocolCallbackRouter;
  coordinator: DesktopAuthCoordinator;
  oauthClient: DesktopOAuthClient;
  callbackState: DesktopAuthCallbackState;
  host: DesktopSupabaseAuthHost;
  log: DesktopAuthLog;
  /** The process runtime the composition root built; every lane and callback
   *  below settles on it. */
  runtime: ProcessRuntime;
}

interface DesktopOAuthClient {
  auth: {
    signInWithOAuth(input: {
      provider: OAuthProvider;
      options: { redirectTo: string };
    }): Promise<{
      data: { url?: string | null };
      error: { message: string } | null;
    }>;
  };
}

/**
 * The session-storage surface this module drives. Token freshness and readiness
 * are not part of it: the account plane (`SupabaseAuth`) the composition root
 * served owns those, and every desktop token read goes through there.
 */
export interface DesktopAuthCoordinator {
  storeSession(session: SupabaseSession): Effect.Effect<void, AuthPortError>;
  clearSession(): Effect.Effect<void, AuthPortError>;
  createSessionFromCallback(
    uri: AuthCallbackUriParts,
  ): Effect.Effect<SupabaseCallbackResult, AuthPortError>;
}

/**
 * Fire-and-forget cleanup: the caller's flow continues whether or not the
 * work lands, and a failure leaves only the debug trace.
 */
function runCleanupDetached(
  runtime: ProcessRuntime,
  log: DesktopAuthLog,
  cleanup: Effect.Effect<unknown, unknown>,
  failureMessage: string,
): void {
  runtime.runFork(
    cleanup.pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          log.debug(
            `${failureMessage}: ${toErrorMessage(Cause.squash(cause))}`,
          );
        }),
      ),
    ),
  );
}

/**
 * Best-effort host notifications: deliver, and warn with the surface's own
 * error when the dialog host is already gone. `notify` is the Effect-shaped
 * host call (a `MessageHost` member, or a wrapped `onSessionChanged`).
 */
function warnOnNotificationFailure(
  log: DesktopAuthLog,
  notify: Effect.Effect<unknown, unknown>,
  failureMessage: string,
): Effect.Effect<void> {
  return notify.pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        log.warn(`${failureMessage}: ${toErrorMessage(Cause.squash(cause))}`);
      }),
    ),
  );
}

export function createDesktopAuthCallbackState(
  runtime: ProcessRuntime,
  log: DesktopAuthLog,
  store?: Pick<StateStore, 'get' | 'update'>,
): DesktopAuthCallbackState {
  let pendingState = readPendingOAuthState(store);
  // One exclusive persist lane, so an expired-state clear cannot be
  // reordered after a newer attempt's persist.
  const persistLanes = new Map<string, PerKeyLane>();
  const persistEffect = (state: PendingOAuthState | null) =>
    withPerKeyLane(
      persistLanes,
      AUTH_PERSIST_LANE,
    )(
      // The store's write is already a program: with no store handed down
      // there is nothing to persist, and its refusal is the caller's failure.
      store
        ? Effect.suspend(() =>
            store.update(DESKTOP_PENDING_OAUTH_STATE_KEY, state),
          )
        : Effect.void,
    );

  // A dropped persist leaves the expired nonce on disk; in-memory state is
  // already cleared, so the next launch re-expires it. Logged so the stale
  // record has a trace rather than appearing out of nowhere.
  const forgetExpiredPendingState = (): void => {
    pendingState = null;
    if (!store) return;
    runtime.runFork(
      persistEffect(null).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            log.debug(
              `Desktop pending OAuth state cleanup failed: ${toErrorMessage(error)}`,
            );
          }),
        ),
      ),
    );
  };

  if (pendingState && !isPendingOAuthStateFresh(pendingState)) {
    forgetExpiredPendingState();
  }

  // True only while a non-expired sign-in attempt is pending; clears and
  // best-effort persists the reset once the stored attempt has expired.
  const hasValidPendingState = (): boolean => {
    if (!pendingState) return false;
    if (!isPendingOAuthStateFresh(pendingState)) {
      forgetExpiredPendingState();
      return false;
    }
    return true;
  };

  return {
    hasPendingSignIn: hasValidPendingState,
    beginAuthAttempt(nonce: string) {
      pendingState = { createdAt: Date.now(), nonce };
      return persistEffect(pendingState);
    },
    matchesPendingNonce: (nonce: string | undefined) => {
      if (!nonce) return false;
      return hasValidPendingState() && pendingState?.nonce === nonce;
    },
    clearAwaitingCallback(nonce?: string) {
      if (nonce && pendingState?.nonce !== nonce) return Effect.void;
      pendingState = null;
      return persistEffect(null);
    },
  };
}

function readPendingOAuthState(
  store: Pick<StateStore, 'get' | 'update'> | undefined,
): PendingOAuthState | null {
  const persisted = store?.get<unknown>(DESKTOP_PENDING_OAUTH_STATE_KEY, null);
  const parsed = PendingOAuthStateSchema.safeParse(persisted);
  return parsed.success ? parsed.data : null;
}

/**
 * One sign-in attempt. Object identity is the ownership token: every step that
 * can commit or clear auth state re-checks `activeAttempt === attempt`, so a
 * superseded attempt can neither store its session nor cancel the newer one.
 */
interface DesktopAuthAttempt {
  readonly nonce: string;
  /** Resolves the `signInAndWaitForSession` waiter attached to this attempt. */
  settle(success: boolean): void;
}

function createAuthAttempt(nonce: string): DesktopAuthAttempt {
  return { nonce, settle: () => {} };
}

export function createDesktopSupabaseAuth(
  options: DesktopSupabaseAuthOptions,
): DesktopSupabaseAuth {
  const {
    callbackState,
    coordinator,
    host,
    log,
    oauthClient,
    router,
    runtime,
  } = options;
  // The callback lane keeps a second deeplink from committing a session while
  // the first is still storing one; the commit lane serializes session
  // storage writes. The lane map itself answers "is a callback in flight",
  // which the queue's `pending` count answered before.
  const authLanes = new Map<string, PerKeyLane>();
  const onCommitLane = withPerKeyLane(authLanes, AUTH_COMMIT_LANE);
  let activeAttempt: DesktopAuthAttempt | undefined;
  const ownsAttempt = (attempt: DesktopAuthAttempt): boolean =>
    activeAttempt === attempt;
  const invalidateActiveAttempt = (): void => {
    const superseded = activeAttempt;
    activeAttempt = undefined;
    superseded?.settle(false);
  };
  const settleAttempt = (
    attempt: DesktopAuthAttempt,
    success: boolean,
  ): void => {
    attempt.settle(success);
    if (ownsAttempt(attempt)) {
      activeAttempt = undefined;
    }
  };
  const waitForCompletion = (
    attempt: DesktopAuthAttempt,
    timeoutMs: number,
  ): Promise<boolean> => {
    // First completion wins: the attempt's own settle, or the timeout. The
    // timeout's sleep belongs to the waiting fiber, so a settle cancels it —
    // no timer outlives its attempt, and none is left over to clear a later
    // attempt's pending callback state.
    const outcome = Deferred.makeUnsafe<boolean>();
    attempt.settle = (success) => {
      Deferred.doneUnsafe(outcome, Effect.succeed(success));
    };
    return runtime.runPromise(
      Effect.gen(function* () {
        const settled = yield* Deferred.await(outcome).pipe(
          Effect.timeoutOption(timeoutMs),
        );
        if (Option.isSome(settled)) return settled.value;
        const wasOwned = ownsAttempt(attempt);
        settleAttempt(attempt, false);
        if (wasOwned) {
          runCleanupDetached(
            runtime,
            log,
            callbackState.clearAwaitingCallback(attempt.nonce),
            'Desktop sign-in timeout cleanup failed',
          );
        }
        return false;
      }),
    );
  };
  const runQueuedCallback = (queued: {
    callback: DesktopProtocolCallback;
    attempt: DesktopAuthAttempt;
  }): Effect.Effect<void> =>
    Effect.gen(function* () {
      const processed = yield* Effect.exit(
        processProtocolCallback(
          coordinator,
          queued.callback,
          host,
          log,
          () => ownsAttempt(queued.attempt),
          onCommitLane,
        ),
      );
      if (Exit.isSuccess(processed)) {
        settleAttempt(queued.attempt, processed.value);
        return;
      }
      settleAttempt(queued.attempt, false);
      const message = toErrorMessage(settleFailure(processed.cause));
      log.error(`Desktop auth callback failed: ${message}`);
      yield* warnOnNotificationFailure(
        log,
        host.showErrorMessage(`Sign-in failed: ${message}`),
        'Desktop sign-in error notification failed',
      );
    });
  const subscription = router.subscribe((callback) => {
    if (!callbackState.hasPendingSignIn()) {
      log.debug(
        'Desktop auth callback ignored because no sign-in is in progress',
      );
      return;
    }
    const callbackNonce = new URLSearchParams(callback.query).get('app_nonce');
    if (!callbackNonce || !callbackState.matchesPendingNonce(callbackNonce)) {
      log.warn(
        'Desktop auth callback rejected: nonce mismatch (possible login-CSRF or stale callback)',
      );
      return;
    }
    activeAttempt ??= createAuthAttempt(callbackNonce);
    const claimedAttempt = activeAttempt;
    if (claimedAttempt.nonce !== callbackNonce) return;
    runCleanupDetached(
      runtime,
      log,
      callbackState.clearAwaitingCallback(callbackNonce),
      'Desktop auth callback state clear failed',
    );
    if (authLanes.has(AUTH_CALLBACK_LANE)) {
      log.debug(
        'Desktop auth callback queued while another callback is being processed',
      );
    }
    // Non-rejecting: `runQueuedCallback` runs the callback through
    // `Effect.exit` and answers both exits itself, settling the attempt,
    // logging the cause, and notifying the user.
    runtime.runFork(
      withPerKeyLane(
        authLanes,
        AUTH_CALLBACK_LANE,
      )(runQueuedCallback({ callback, attempt: claimedAttempt })),
    );
  });

  const startSignInAttempt = (
    provider: OAuthProvider,
    attempt: DesktopAuthAttempt,
  ): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
      // Drain the commit lane before claiming the attempt, so a callback still
      // storing or clearing a session finishes against the attempt it owns.
      yield* onCommitLane(Effect.void);
      if (!ownsAttempt(attempt)) return;

      // Bind this attempt to a one-time nonce carried on the callback URL.
      // Supabase preserves redirect_to query params through to the callback
      // (the same mechanism the Codespaces ?state= routing token relies on),
      // so the nonce returns in the texra:// callback query — letting us reject
      // a foreign token deeplink delivered while a sign-in is merely pending.
      const callbackUri = getAuthCallbackUri(TEXRA_PROTOCOL);
      const sep = callbackUri.includes('?') ? '&' : '?';
      const redirectTo = `${callbackUri}${sep}app_nonce=${attempt.nonce}`;
      yield* callbackState.beginAuthAttempt(attempt.nonce);
      if (!ownsAttempt(attempt)) return;
      const { data, error } = yield* Effect.tryPromise({
        try: () =>
          oauthClient.auth.signInWithOAuth({
            provider,
            options: { redirectTo },
          }),
        catch: (cause) => cause,
      });
      const authUrl = requireOAuthRedirectUrl(data, error);
      if (!ownsAttempt(attempt)) return;

      yield* host.openExternalUrl(authUrl);
      yield* host.showInfoMessage(
        'Complete sign-in in your browser. TeXRA updates automatically when it finishes.',
      );
    });

  const startSignIn = (
    provider: OAuthProvider,
    onAttempt?: (attempt: DesktopAuthAttempt) => void,
  ): Effect.Effect<void, unknown> =>
    Effect.gen(function* () {
      invalidateActiveAttempt();
      const nonce = randomBytes(16).toString('hex');
      const attempt = createAuthAttempt(nonce);
      activeAttempt = attempt;
      onAttempt?.(attempt);
      const started = yield* Effect.exit(startSignInAttempt(provider, attempt));
      if (Exit.isFailure(started)) {
        if (ownsAttempt(attempt)) activeAttempt = undefined;
        yield* callbackState.clearAwaitingCallback(nonce);
        yield* Effect.failCause(started.cause);
      }
    });

  return {
    async signIn(provider = DEFAULT_OAUTH_PROVIDER) {
      const started = await runtime.runPromiseExit(startSignIn(provider));
      if (Exit.isFailure(started)) throw Cause.squash(started.cause);
    },

    async signInAndWaitForSession(
      provider = DEFAULT_OAUTH_PROVIDER,
      waitOptions = {},
    ) {
      let startedAttempt: DesktopAuthAttempt | undefined;
      let completion: Promise<boolean> | undefined;
      const started = await runtime.runPromiseExit(
        startSignIn(provider, (attempt) => {
          startedAttempt = attempt;
          completion = waitForCompletion(
            attempt,
            waitOptions.timeoutMs ?? AUTH_CALLBACK_TIMEOUT_MS,
          );
        }),
      );
      if (Exit.isFailure(started)) {
        startedAttempt?.settle(false);
        throw Cause.squash(started.cause);
      }
      return completion ?? false;
    },

    async signOut() {
      invalidateActiveAttempt();
      const cleared = await runtime.runPromiseExit(
        Effect.gen(function* () {
          yield* onCommitLane(
            Effect.gen(function* () {
              yield* callbackState.clearAwaitingCallback();
              yield* coordinator.clearSession();
            }),
          );
          yield* refreshRemoteAgentCatalogAfterSignOut(
            invalidateRemoteAgentsAfterSignOut(),
            (message) => log.warn(message),
          );
        }),
      );
      if (Exit.isFailure(cleared)) throw settleFailure(cleared.cause);
      await host.onSessionChanged();
    },

    dispose() {
      invalidateActiveAttempt();
      subscription.dispose();
    },
  };
}

export function createDesktopAuthCoordinator(options: {
  /** The account plane the composition root built and served as
   *  `SupabaseAuth`. */
  auth: SupabaseAuthShape;
  /** The process runtime the composition root built; the auth subsystem's run
   *  edge is installed over it. */
  runtime: ProcessRuntime;
}): DesktopAuthCoordinator {
  // The auth subsystem's run edge lives at this host entry (PRD R1). The
  // coordinator's surface is already Effect-typed, so the auth flows above
  // compose it directly; only the CLI's own composition root settles auth
  // programs through `runAuthProgram`.
  installAuthProgramEdge((program) => options.runtime.runPromiseExit(program));
  return options.auth.coordinator;
}

function processProtocolCallback(
  coordinator: DesktopAuthCoordinator,
  callback: DesktopProtocolCallback,
  host: DesktopSupabaseAuthHost,
  log: DesktopAuthLog,
  ownsAttempt: () => boolean,
  onCommitLane: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>,
): Effect.Effect<boolean, unknown> {
  return Effect.gen(function* () {
    const result = yield* coordinator.createSessionFromCallback({
      path: callback.path,
      query: callback.query,
    });

    if (!result.success) {
      if (result.isAuthError) {
        const callbackError = new URLSearchParams(callback.query).get('error');
        if (callbackError === 'access_denied') {
          log.info('Desktop sign-in was cancelled in the system browser');
          return false;
        }
        yield* warnOnNotificationFailure(
          log,
          host.showErrorMessage(`Sign-in failed: ${result.error}`),
          'Desktop sign-in error notification failed',
        );
      } else {
        log.debug(`Desktop auth callback ignored: ${result.error}`);
      }
      return false;
    }

    return yield* onCommitLane(
      Effect.gen(function* () {
        // The attempt can be invalidated at any suspension point (a newer
        // sign-in or a timeout). Once it is, the session must not be kept.
        const stillOwned = (): Effect.Effect<boolean, AuthPortError> =>
          ownsAttempt()
            ? Effect.succeed(true)
            : Effect.as(coordinator.clearSession(), false);

        if (!ownsAttempt()) return false;
        yield* coordinator.storeSession(result.session);
        if (!(yield* stillOwned())) return false;

        yield* warnOnNotificationFailure(
          log,
          host.showInfoMessage(`Signed in as ${result.session.account.label}`),
          'Desktop sign-in notification failed',
        );
        if (!(yield* stillOwned())) return false;

        yield* warnOnNotificationFailure(
          log,
          Effect.tryPromise({
            try: async () => {
              await host.onSessionChanged();
            },
            catch: (cause) => cause,
          }),
          'Desktop auth surface refresh failed',
        );
        return yield* stillOwned();
      }),
    );
  });
}

export function createSessionLog(log: DesktopAuthLog): SupabaseSessionLog {
  return {
    debug: (source, message, options) =>
      log.debug(`[${source}] ${message}`, options?.data),
    info: (source, message, options) =>
      log.info(`[${source}] ${message}`, options?.data),
    warn: (source, message, options) =>
      log.warn(`[${source}] ${message}`, options?.data),
    error: (source, message, options) =>
      log.error(`[${source}] ${message}`, options?.data),
  };
}
