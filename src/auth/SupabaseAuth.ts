import {
  createClient,
  SupabaseClient as Client,
  User,
  type SupportedStorage,
} from '@supabase/supabase-js';
import { Context, Effect, Layer } from 'effect';
import { createLog } from '@logger/logUtils';
import type { SecretsFailed } from '@platform/secrets';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';
import { callPort, settleFailure } from './authProgram';
import {
  SUPABASE_CONFIG,
  SUPABASE_GOTRUE_STORAGE_KEY,
  SUPABASE_SESSION_KEY,
  TOKEN_REFRESH_THRESHOLD_MS,
} from './config';
import {
  secretBackedSessionStorage,
  type SessionSecretStore,
} from './oauth/sessionAccess';
import {
  SupabaseSessionCoordinator,
  type SupabaseSessionLog,
} from './SupabaseSession';
import type { StoredSessionState } from './TokenProvider';

const log = createLog('SupabaseAuth');

/**
 * GoTrue storage for the host's client.
 *
 * Browser OAuth is a two-hop handshake: the window that starts sign-in
 * generates the PKCE `code_verifier`, and the deep link carrying the one-time
 * `?code=` back is delivered by the OS to whichever editor window the host
 * picks — not necessarily that one. GoTrue's own storage is a plain
 * in-process object, so a callback landing in another window (or after the
 * extension host reloaded) found no verifier and failed the exchange with
 * `pkce_code_verifier_not_found`.
 *
 * Every key GoTrue derives from its storage key is PKCE flow state (the
 * `-code-verifier` slots and their flow index); those go to the host secret
 * store, which is shared across windows and survives a reload. The bare
 * storage key is GoTrue's session slot and stays in memory on purpose: the
 * host's own session record remains the single owner of the signed-in
 * session, so nothing session-shaped is ever persisted here.
 *
 * This is the one shape `@supabase/auth-js` accepts, and it is only consulted
 * when `persistSession` is true — hence that flag below.
 *
 * The sign-in coordinator stores the flow id beside its application nonce on
 * every host and passes it directly to code exchange, so concurrent attempts
 * select separate verifier slots without adding another callback query
 * parameter; a sign-in whose initialization returns no flow id fails rather
 * than falling back to auth-js's fixed verifier. Flow-id slots are tracked in
 * a five-entry index; concurrent starts in separate hosts can race that index.
 */
function gotrueStorage(
  secrets: SessionSecretStore,
  services: Context.Context<never>,
): SupportedStorage {
  // Writes are mirrored here so a secret-store failure degrades to the old
  // in-process behavior (same-window sign-in still completes) instead of
  // losing the flow outright.
  const memory = new Map<string, string>();

  /**
   * Run one secret-store operation, unless the key is the session slot. That
   * slot and a failed store both answer `undefined`, which every caller
   * resolves against the memory mirror. The store is Effect-typed, so the
   * recovery is part of the program and only its result crosses
   * `@supabase/auth-js`'s own Promise callback surface — the one outbound
   * foreign Promise contract this plane owes, run on the services the plane
   * captured when it was built (rulings ledger, #12720).
   */
  const onCapturedServices = Effect.runPromiseWith(services);
  const onFlowState = <T>(
    action: string,
    key: string,
    program: Effect.Effect<T, SecretsFailed>,
  ): Promise<T | undefined> => {
    if (key === SUPABASE_GOTRUE_STORAGE_KEY) return Promise.resolve(undefined);
    return onCapturedServices(
      program.pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            log.warn(
              `Could not ${action} PKCE flow state (${key}); sign-in will ` +
                `only be completable in this window: ` +
                `${toErrorMessage(settleFailure(cause))}`,
            );
            return undefined;
          }),
        ),
      ),
    );
  };

  return {
    // A degraded store can answer an absent value instead of throwing (e.g. a
    // locked keychain that denies decryption). The mirrored write is still
    // this window's best answer, so a miss falls back like a failure does.
    getItem: async (key) =>
      (await onFlowState('read', key, secrets.get(key))) ??
      memory.get(key) ??
      null,
    setItem: async (key, value) => {
      memory.set(key, value);
      await onFlowState('store', key, secrets.set(key, value));
    },
    removeItem: async (key) => {
      memory.delete(key);
      await onFlowState('clear', key, secrets.delete(key));
    },
  };
}

/**
 * What a host's composition root supplies to build the account plane. The
 * `whenReady` gate exists only on the VS Code host, which must not answer
 * "ready" before its OAuth URI handler is installed.
 */
export interface SupabaseAuthInit {
  readonly secrets: SessionSecretStore;
  readonly log?: SupabaseSessionLog;
  readonly whenReady?: () => Effect.Effect<void, Error>;
}

/**
 * The host's TeXRA account plane: the GoTrue client, the session coordinator
 * that owns the stored session, and the signed-in probes the account UI, the
 * remote catalog, telemetry, and the setup tools read. Every probe settles
 * its own failure to the signed-out answer (logging where the facade did), so
 * a program that only asks "is there a session" never fails; a composition
 * with no account plane serves {@link unavailableSupabaseAuth}.
 */
export interface SupabaseAuthShape {
  /**
   * The GoTrue client, for the host sign-in flows that drive it directly.
   * Raises the not-initialized error on an unavailable plane.
   */
  readonly client: Client;
  /**
   * The session coordinator a host's own sign-in surface drives. Raises the
   * not-initialized error on an unavailable plane.
   */
  readonly coordinator: SupabaseSessionCoordinator;
  /** Auth system fully initialized and its readiness gate open. */
  readonly isReady: Effect.Effect<boolean>;
  /** The current access token, refreshed when near expiry; null when signed out. */
  readonly accessToken: Effect.Effect<string | null>;
  /** The current authenticated user; null when signed out. */
  readonly user: Effect.Effect<User | null>;
  readonly authenticated: Effect.Effect<boolean>;
  /**
   * Health of the stored GoTrue session. This is the canonical classification
   * for account UI and commands.
   */
  readonly storedSessionState: Effect.Effect<StoredSessionState>;
  /**
   * The stored session's account label without attempting a token refresh;
   * null when no session is stored or the read fails.
   */
  readonly storedAccountLabel: Effect.Effect<string | null>;
  /** The initialization or readiness failure a sign-in surface reports. */
  readonly getInitError: () => Error | null;
  /** Record an initialization failure for later retrieval. */
  readonly setInitError: (error: Error) => void;
}

/**
 * The TeXRA account plane as an Effect service, provided once per process by
 * the host composition root through `installProcessRuntime`'s `auth` option.
 * Consumers inside Effect programs `yield* SupabaseAuth`; the Promise-facing
 * host edges settle the shape's programs on the process runtime they hold.
 */
export class SupabaseAuth extends Context.Service<
  SupabaseAuth,
  SupabaseAuthShape
>()('@texra/auth/SupabaseAuth') {
  static layer(auth: SupabaseAuthShape): Layer.Layer<SupabaseAuth> {
    return Layer.succeed(SupabaseAuth)(auth);
  }
}

/**
 * The signed-in probe for catalog gating: the account plane's `authenticated`
 * where the process composition serves one, `false` where it does not (the
 * embeddable agent package composes no account plane). Binding this into a
 * port keeps that port's type free of a `SupabaseAuth` requirement.
 */
export const supabaseAuthenticated: Effect.Effect<boolean> = Effect.flatMap(
  Effect.serviceOption(SupabaseAuth),
  (auth) =>
    auth._tag === 'Some' ? auth.value.authenticated : Effect.succeed(false),
);

/**
 * Build the account plane against TeXRA's Supabase backend, capturing the
 * services of the fiber that builds it: the GoTrue storage adapter owes
 * `@supabase/auth-js` a Promise, and that is the one site where this plane
 * runs a program of its own (rulings ledger, #12720). Fails when the
 * configured credentials are missing or the client refuses them; the
 * extension's composition root is the one host that degrades that to
 * {@link unavailableSupabaseAuth} instead of failing activation.
 */
export function createSupabaseAuth(
  init: SupabaseAuthInit,
): Effect.Effect<SupabaseAuthShape, Error> {
  return Effect.gen(function* () {
    if (!SUPABASE_CONFIG.url || !SUPABASE_CONFIG.publicKey) {
      return yield* Effect.fail(
        new Error(
          'Supabase authentication is not configured: Supabase credentials missing. Check the TeXRA configuration.',
        ),
      );
    }
    const services = yield* Effect.context<never>();
    const client = yield* Effect.try({
      try: () =>
        createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.publicKey, {
          auth: {
            // `persistSession` is what gates GoTrue's use of `storage` at all; the
            // adapter above is what keeps this honest, writing PKCE flow state
            // only and never the session, which the host's secret storage owns.
            // GoTrue's construction-time session read asks for the bare
            // session-slot key, which the adapter short-circuits without running
            // anything — the captured services exist by then either way.
            persistSession: true,
            storage: gotrueStorage(init.secrets, services),
            storageKey: SUPABASE_GOTRUE_STORAGE_KEY,
            autoRefreshToken: false, // Manual refresh via auth provider
            // PKCE: browser OAuth returns a one-time ?code= (not tokens) to the
            // callback, which exchangeCodeForSession trades for a session using
            // the stored verifier, so no access/refresh token ever transits the
            // browser or the auth-bridge page. detectSessionInUrl is off because
            // every host parses its own callback and exchanges the code explicitly.
            flowType: 'pkce',
            detectSessionInUrl: false,
          },
        }),
      catch: (cause) => ensureError(cause),
    });
    const coordinator = new SupabaseSessionCoordinator({
      storage: secretBackedSessionStorage(init.secrets, SUPABASE_SESSION_KEY),
      getClient: () => client,
      whenReady: init.whenReady ?? (() => Effect.void),
      tokenRefreshThresholdMs: TOKEN_REFRESH_THRESHOLD_MS,
      log: init.log,
    });

    let initError: Error | null = null;
    let readinessError: Error | null = null;

    const accessToken: Effect.Effect<string | null> = coordinator
      .ensureFreshToken()
      .pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            log.error(
              `Error getting access token: ` +
                `${toErrorMessage(settleFailure(cause))}`,
            );
            return null;
          }),
        ),
      );

    return {
      client,
      coordinator,
      isReady: Effect.suspend(() => {
        if (initError !== null) return Effect.succeed(false);
        return coordinator.whenReady().pipe(
          Effect.map(() => {
            readinessError = null;
            return true;
          }),
          Effect.catchCause((cause) =>
            Effect.sync(() => {
              const error = settleFailure(cause);
              readinessError = ensureError(error);
              log.error(`Auth provider not ready: ${toErrorMessage(error)}`);
              return false;
            }),
          ),
        );
      }),
      accessToken,
      user: Effect.flatMap(accessToken, (token): Effect.Effect<User | null> =>
        token === null
          ? Effect.succeed(null)
          : callPort(() => client.auth.getUser(token)).pipe(
              Effect.map(({ data, error }) =>
                error || !data.user ? null : data.user,
              ),
              Effect.catchCause((cause) =>
                Effect.sync(() => {
                  log.error(
                    `Error getting user: ${toErrorMessage(settleFailure(cause))}`,
                  );
                  return null;
                }),
              ),
            ),
      ),
      authenticated: Effect.map(accessToken, (token) => token !== null),
      storedSessionState: coordinator.getStoredSessionState(),
      storedAccountLabel: coordinator.getStoredAccountLabel().pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            // A failed read is otherwise indistinguishable from "no session
            // stored", and both collapse to the generic account label in
            // the UI.
            log.warn(
              `Error reading stored account label: ` +
                `${toErrorMessage(settleFailure(cause))}`,
            );
            return null;
          }),
        ),
      ),
      getInitError: () => initError ?? readinessError,
      setInitError: (error) => {
        initError = error;
      },
    };
  });
}

/**
 * The account plane a composition without one serves: every probe answers
 * signed-out, and reaching for the client or coordinator raises the recorded
 * initialization error (or the plain not-initialized one) — what the static
 * facade answered before any host initialized it.
 */
export function unavailableSupabaseAuth(
  initError: Error | null = null,
): SupabaseAuthShape {
  let recorded = initError;
  const notInitialized = (): never => {
    throw (
      recorded ?? new Error('Supabase client not initialized. Restart TeXRA.')
    );
  };
  return {
    get client(): Client {
      return notInitialized();
    },
    get coordinator(): SupabaseSessionCoordinator {
      return notInitialized();
    },
    isReady: Effect.succeed(false),
    accessToken: Effect.succeed(null),
    user: Effect.succeed(null),
    authenticated: Effect.succeed(false),
    storedSessionState: Effect.succeed('none'),
    storedAccountLabel: Effect.succeed(null),
    getInitError: () => recorded,
    setInitError: (error) => {
      recorded = error;
    },
  };
}
