import { Cause, Effect, Exit } from 'effect';
import { z } from 'zod';

import { SerializedWrites, settleFailure } from '@auth/authProgram';
import {
  DEFAULT_OAUTH_PROVIDER,
  getAuthCallbackUri,
  type OAuthProvider,
} from '@auth/config';
import type { SupabaseAuthShape } from '@auth/SupabaseAuth';
import type {
  SupabaseSession,
  SupabaseSessionLog,
} from '@auth/SupabaseSession';
import {
  PendingOAuthStore,
  withCallbackNonce,
} from '@controllers/auth/pendingOAuthStore';
import {
  SignInCancelled,
  SupabaseSignInCoordinator,
  type AuthCallbackTransport,
  type SignInCallbackOutcome,
} from '@controllers/auth/supabaseSignIn';
import type { MessageHost } from '@hosts/uiHosts';
import type { StateStore, StateReadFailed } from '@platform/interfaces';
import {
  withProcessServices,
  type ProcessRuntime,
  type ProcessServices,
} from '@platform/processRuntime';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import { TEXRA_PROTOCOL } from '../shared/desktopProtocol.js';
import type { DesktopProtocolCallbackRouter } from './desktopProtocolCallbacks.js';

const DESKTOP_PENDING_OAUTH_STATE_KEY = 'texra.desktop.pendingOAuthState';

/** The stored records, keyed by nonce; each value is one pending record. */
const PendingRecordsSchema = z.record(z.string(), z.string());

interface DesktopSupabaseAuth {
  /** Start the browser sign-in for one provider. The attempt outlives the
   *  call: its outcome is reported through the host, not to the caller. */
  signIn(provider?: OAuthProvider): Effect.Effect<void>;
  /** Start the browser sign-in and answer whether a session landed before
   *  the callback deadline. */
  signInAndWaitForSession(
    provider?: OAuthProvider,
    options?: { timeoutMs?: number },
  ): Effect.Effect<boolean>;
  signOut(): Promise<void>;
  dispose(): void;
}

type DesktopAuthLog = Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;

export interface DesktopSupabaseAuthHost extends Pick<
  MessageHost,
  'showInfoMessage' | 'showErrorMessage'
> {
  /** The window's `openExternal` with its own "could not open" dialog
   *  suppressed: this flow words a missing browser itself. */
  openExternalUrl(url: string): Effect.Effect<void, unknown>;
  /** Repaint every surface an account change touches. A program, so the
   *  callback that commits a session runs it inside its own fiber. */
  onSessionChanged(): Effect.Effect<void, unknown, ProcessServices>;
}

interface DesktopSupabaseAuthOptions {
  router: DesktopProtocolCallbackRouter;
  /** The account plane the composition root built and served as
   *  `SupabaseAuth`. */
  auth: SupabaseAuthShape;
  /** The pending-record store, opened before the window so a deep link that
   *  launched the app can still be claimed. */
  store: PendingOAuthStore;
  host: DesktopSupabaseAuthHost;
  log: DesktopAuthLog;
  /** The process runtime the composition root built; every callback and
   *  forked attempt below settles on it. */
  runtime: ProcessRuntime;
}

/**
 * The desktop's pending sign-in records. One Electron process owns the state
 * store, so the records live as one JSON object under a single key rather
 * than as one entry each — there is no second writer to lose a record to.
 * Writes are serialized so a clear cannot land after the attempt that
 * replaced it.
 */
export function createDesktopPendingOAuthStore(
  log: DesktopAuthLog,
  store?: Pick<StateStore, 'get' | 'update'>,
): PendingOAuthStore {
  let memoryRecords: Record<string, string> = {};
  const writes = new SerializedWrites();
  const read = (): Effect.Effect<Record<string, string>, StateReadFailed> =>
    store ? readPendingRecords(log, store) : Effect.sync(() => memoryRecords);
  const change = (
    transform: (records: Record<string, string>) => Record<string, string>,
  ) =>
    writes.run(
      Effect.gen(function* () {
        const next = transform(yield* read());
        if (store) yield* store.update(DESKTOP_PENDING_OAUTH_STATE_KEY, next);
        else memoryRecords = next;
      }),
    );
  return new PendingOAuthStore({
    read: (nonce) => Effect.map(read(), (records) => records[nonce]),
    write: (nonce, value) =>
      change((records) => ({ ...records, [nonce]: value })),
    erase: (nonce) =>
      change((records) => {
        const { [nonce]: _dropped, ...rest } = records;
        return rest;
      }),
    nonces: () => Effect.map(read(), Object.keys),
  });
}

const readPendingRecords = Effect.fn('desktopAuth.readPendingRecords')(
  function* (log: DesktopAuthLog, store: Pick<StateStore, 'get' | 'update'>) {
    const persisted = yield* store.get<unknown>(
      DESKTOP_PENDING_OAUTH_STATE_KEY,
      null,
    );
    if (persisted == null) return {};
    const parsed = PendingRecordsSchema.safeParse(persisted);
    if (!parsed.success) {
      log.warn(
        'Stored desktop OAuth callback state is malformed and will be ignored',
      );
      return {};
    }
    return parsed.data;
  },
);

export function createDesktopSupabaseAuth(
  options: DesktopSupabaseAuthOptions,
): DesktopSupabaseAuth {
  const { auth, host, log, router, runtime, store } = options;

  const warnOnNotificationFailure = <A, E, R>(
    notify: Effect.Effect<A, E, R>,
    failureMessage: string,
  ): Effect.Effect<void, never, R> =>
    notify.pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          log.warn(`${failureMessage}: ${toErrorMessage(Cause.squash(cause))}`);
        }),
      ),
    );

  const reportSignedIn = (
    session: SupabaseSession,
  ): Effect.Effect<void, never, ProcessServices> =>
    Effect.gen(function* () {
      yield* warnOnNotificationFailure(
        host.showInfoMessage(`Signed in as ${session.account.label}`),
        'Desktop sign-in notification failed',
      );
      yield* warnOnNotificationFailure(
        host.onSessionChanged(),
        'Desktop auth surface refresh failed',
      );
    });

  const reportSignInFailure = (
    message: string,
  ): Effect.Effect<void, never, ProcessServices> =>
    Effect.gen(function* () {
      log.error(`Desktop sign-in failed: ${message}`);
      yield* warnOnNotificationFailure(
        host.showErrorMessage(`Sign-in failed: ${message}`),
        'Desktop sign-in error notification failed',
      );
    });

  const announce = (
    outcome: SignInCallbackOutcome,
  ): Effect.Effect<void, never, ProcessServices> => {
    if (outcome.kind === 'committed') return reportSignedIn(outcome.session);
    if (outcome.kind === 'failed') return reportSignInFailure(outcome.message);
    log.debug(`Desktop auth callback ignored: ${outcome.reason}`);
    return Effect.void;
  };

  const transport: AuthCallbackTransport = {
    // Supabase preserves redirect_to query params through to the callback, so
    // the nonce returns in the texra:// callback query — which is what lets a
    // foreign token deeplink delivered while a sign-in is pending be refused.
    open: (route) =>
      Effect.succeed(
        withCallbackNonce(getAuthCallbackUri(TEXRA_PROTOCOL), route.nonce),
      ),
    presentSignInUrl: (url) =>
      Effect.andThen(
        host.openExternalUrl(url),
        host.showInfoMessage(
          'Complete sign-in in your browser. TeXRA updates automatically when it finishes.',
        ),
      ).pipe(Effect.mapError(ensureError)),
    announce,
  };

  const coordinator = new SupabaseSignInCoordinator({
    auth,
    store,
    transport,
  });

  const subscription = router.subscribe((callback) => {
    runtime.runFork(
      Effect.asVoid(
        coordinator.acceptCallback({
          path: callback.path,
          query: callback.query,
        }),
      ),
    );
  });

  /**
   * One attempt, with its outcome worded by this host. Never fails: the
   * banner and the settings row that start a sign-in are not the place a
   * browser round trip's failure is reported.
   */
  const runAttempt = (
    provider: OAuthProvider,
    timeoutMs?: number,
  ): Effect.Effect<boolean> =>
    withProcessServices(
      runtime,
      coordinator.signIn({ provider, timeoutMs }).pipe(
        Effect.flatMap((session) => Effect.as(reportSignedIn(session), true)),
        Effect.catchCause((cause) => {
          const failure = settleFailure(cause);
          // Declining consent in the browser is the user's own decision, not
          // something to raise a dialog about.
          if (failure instanceof SignInCancelled) {
            log.info('Desktop sign-in was cancelled in the system browser');
            return Effect.succeed(false);
          }
          return Effect.as(reportSignInFailure(toErrorMessage(failure)), false);
        }),
      ),
    );

  return {
    signIn: (provider = DEFAULT_OAUTH_PROVIDER) =>
      Effect.asVoid(Effect.forkDetach(runAttempt(provider))),

    signInAndWaitForSession: (
      provider = DEFAULT_OAUTH_PROVIDER,
      waitOptions = {},
    ) => runAttempt(provider, waitOptions.timeoutMs),

    async signOut() {
      const cleared = await runtime.runPromiseExit(
        Effect.gen(function* () {
          yield* coordinator.signOut();
          yield* warnOnNotificationFailure(
            host.onSessionChanged(),
            'Desktop auth surface refresh failed',
          );
        }),
      );
      if (Exit.isFailure(cleared)) throw settleFailure(cleared.cause);
    },

    /**
     * Closing this window unsubscribes it from the protocol router, and
     * nothing more: on macOS the process outlives its last window, so a
     * sign-in the user is still completing in the browser must keep its
     * pending record. The router queues that callback and the next window's
     * coordinator adopts it, exactly as a cold start does. Cancelling here
     * would erase the record and refuse the callback instead; the attempt's
     * own deadline still clears it when nobody completes the sign-in.
     */
    dispose() {
      subscription.dispose();
    },
  };
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
