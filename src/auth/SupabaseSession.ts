import { Clock, Deferred, Effect } from 'effect';

import { withLogChannel } from '@logger/effectLog';
import { toErrorMessage } from '@utils/errors/errorMessage';
import {
  parseAuthCallbackCode,
  type AuthCallbackUriParts,
} from './authCallback';
import { AuthPortError, callPort, SerializedWrites } from './authProgram';
import {
  parseStoredSupabaseSession,
  toStorableSupabaseSession,
  type SupabaseCallbackResult,
  type SupabaseSession,
  type SupabaseSessionStorage,
} from './supabaseSessionTypes';
import {
  classifyAuthFailureStatus,
  type SessionRefreshFailure,
  type StoredSessionState,
} from './TokenProvider';
import type { SupabaseClient as Client } from '@supabase/supabase-js';

// Public entry point for the session value-object helpers and coordinator.
// Only the symbols consumers actually use are forwarded; the Zod schemas and
// callback/parse option types stay internal to `supabaseSessionTypes`.
export {
  GitHubTokenExchangeSchema,
  toStorableSupabaseSession,
  type SupabaseCallbackResult,
  type SupabaseSession,
} from './supabaseSessionTypes';

const CHANNEL = 'SupabaseSession';

export interface SupabaseSessionCoordinatorOptions {
  storage: SupabaseSessionStorage;
  getClient: () => Client;
  whenReady: () => Effect.Effect<void, Error>;
  tokenRefreshThresholdMs: number;
}

/**
 * Host-neutral coordinator for Supabase session storage, token freshness,
 * OAuth callback conversion, and refresh. Host wrappers own UI and registration.
 *
 * The public surface is Effect-typed (PRD R1): each method is one of the
 * programs below, and the caller runs it. Storage and GoTrue rejections
 * travel as {@link AuthPortError}; the `SupabaseAuth` plane wraps the probes
 * with their signed-out recoveries, and a host's Promise-facing sign-in
 * surface settles the rest on its own runtime, unwrapping the port's own
 * error (`unwrapAuthPortCause`, `settleFailure`).
 */
export class SupabaseSessionCoordinator {
  private refreshInFlight: Deferred.Deferred<SupabaseSession | null> | null =
    null;
  private sessionMutationVersion = 0;
  private lastRefreshFailure: SessionRefreshFailure | null = null;
  // Serialized writes, same mechanism as SubscriptionOAuthCoordinator's
  // `sessionMutations`: every write bumps `sessionMutationVersion` under the
  // permit, so its idle barrier plus a version recheck is `stableSnapshot`'s
  // "no mutation in flight, and none started during the read" guarantee.
  private readonly sessionMutations = new SerializedWrites();

  constructor(private readonly options: SupabaseSessionCoordinatorOptions) {}

  whenReady(): Effect.Effect<void, AuthPortError> {
    return this.options
      .whenReady()
      .pipe(Effect.mapError((cause) => new AuthPortError({ cause })));
  }

  storeSession(session: SupabaseSession): Effect.Effect<void, AuthPortError> {
    return this.mutate(this.write(session));
  }

  clearSession(): Effect.Effect<void, AuthPortError> {
    return this.mutate(this.options.storage.delete());
  }

  /**
   * Clear the stored session only if it still has the credential pair observed
   * by the caller. A completed OAuth callback or refresh may replace a session
   * while an older validation request is in flight; that older result must not
   * delete the replacement.
   */
  clearSessionIfCurrent(
    expected: SupabaseSession,
  ): Effect.Effect<boolean, AuthPortError> {
    return this.sessionMutations.run(this.clearIfCurrent(expected));
  }

  /**
   * Ensure the access token is fresh, refreshing proactively if near expiry.
   * Resolves to the fresh access token, or null if no session or refresh
   * failed; a port rejection is logged where its disposition is decided.
   */
  ensureFreshToken(): Effect.Effect<string | null> {
    return Effect.map(
      this.freshSession(),
      (session) => session?.accessToken ?? null,
    );
  }

  /**
   * Classify one stable stored-session generation. A callback may replace the
   * session while refresh is in flight; in that case retry rather than apply
   * the old credential's failure to the new one.
   */
  getStoredSessionState(): Effect.Effect<StoredSessionState> {
    return this.storedSessionState().pipe(
      Effect.catchTag('AuthPortError', (error) =>
        Effect.logError(
          `Error classifying stored session: ${toErrorMessage(error.cause)}`,
        ).pipe(withLogChannel(CHANNEL), Effect.as('transient' as const)),
      ),
    );
  }

  /**
   * Read the stored session's account label without attempting a token
   * refresh. Returns null when no session is stored; a storage rejection
   * travels as {@link AuthPortError} and the caller decides what to show.
   */
  getStoredAccountLabel(): Effect.Effect<string | null, AuthPortError> {
    return Effect.map(
      this.loadSession(),
      (session) => session?.account.label ?? null,
    );
  }

  /**
   * The most recent refresh failure: `invalid` means the credential was
   * authoritatively rejected; `transient` covers transport and service
   * failures for which reconnecting would be premature.
   */
  getLastRefreshFailure(): SessionRefreshFailure | null {
    return this.lastRefreshFailure;
  }

  /** Convert a PKCE OAuth callback into a host-neutral session record. */
  createSessionFromCallback(
    uri: AuthCallbackUriParts,
    flowId?: string,
  ): Effect.Effect<SupabaseCallbackResult, AuthPortError> {
    const parsedCode = parseAuthCallbackCode(uri);
    return parsedCode.success
      ? this.exchangeCode(parsedCode.code, flowId)
      : Effect.succeed(parsedCode);
  }

  /** Read and parse the stored session. */
  readonly loadSession = Effect.fn('SupabaseSessionCoordinator.loadSession')(
    function* (this: SupabaseSessionCoordinator) {
      const raw = yield* this.options.storage.get();
      const warnings: string[] = [];
      const session = parseStoredSupabaseSession(raw, (message) =>
        warnings.push(message),
      );
      for (const warning of warnings) {
        yield* Effect.logWarning(warning).pipe(withLogChannel(CHANNEL));
      }
      return session;
    },
  );

  private write(session: SupabaseSession): Effect.Effect<void, AuthPortError> {
    return this.options.storage.store(JSON.stringify(session));
  }

  /** Run one storage write behind the permit, bumping the version it ran at. */
  private mutate(
    write: Effect.Effect<void, AuthPortError>,
  ): Effect.Effect<void, AuthPortError> {
    return this.sessionMutations.run(
      Effect.suspend(() => {
        this.sessionMutationVersion += 1;
        return write;
      }),
    );
  }

  /** The body of {@link clearSessionIfCurrent}; the caller holds the permit. */
  private readonly clearIfCurrent = Effect.fn(
    'SupabaseSessionCoordinator.clearSessionIfCurrent',
  )(function* (this: SupabaseSessionCoordinator, expected: SupabaseSession) {
    const current = yield* this.loadSession();
    if (
      !current ||
      current.accessToken !== expected.accessToken ||
      current.refreshToken !== expected.refreshToken
    ) {
      return false;
    }
    this.sessionMutationVersion += 1;
    yield* this.options.storage.delete();
    return true;
  });

  /** A stable read: no mutation in flight, and none started during the read. */
  private readonly stableSnapshot = Effect.fn(
    'SupabaseSessionCoordinator.stableSnapshot',
  )(function* (this: SupabaseSessionCoordinator) {
    for (;;) {
      const versionBeforeLoad = this.sessionMutationVersion;
      // A mutation that starts after the barrier bumps the version and
      // re-loops.
      yield* this.sessionMutations.awaitIdle();
      const session = yield* this.loadSession();
      if (versionBeforeLoad === this.sessionMutationVersion) {
        return { session, version: versionBeforeLoad };
      }
    }
  });

  private readonly exchangeCode = Effect.fn(
    'SupabaseSessionCoordinator.createSessionFromCallback',
  )(function* (
    this: SupabaseSessionCoordinator,
    code: string,
    flowId?: string,
  ) {
    const { data, error } = yield* callPort(() =>
      this.options
        .getClient()
        .auth.exchangeCodeForSession(code, flowId ? { flowId } : undefined),
    );

    if (error || !data.session) {
      // A missing verifier means this callback belongs to a sign-in attempt
      // whose flow state is gone — a link opened on another machine, or one
      // left over from before the session was cleared. GoTrue's own wording
      // for it advises `@supabase/ssr` and cookies, which is meaningless in
      // an editor, so say what the user can actually do.
      return {
        success: false,
        error:
          error?.code === 'pkce_code_verifier_not_found'
            ? 'this sign-in link is no longer valid. It was either opened on ' +
              'another machine or left over from an earlier attempt. Start ' +
              'sign-in again.'
            : error?.message || 'Code exchange failed',
        isAuthError: true,
      } as const;
    }

    return {
      success: true,
      session: toStorableSupabaseSession(data.session),
    } as const;
  });

  /**
   * Single-flight refresh: concurrent callers share the in-flight result. The
   * check and the claim share one synchronous segment — no `yield*` between
   * them, since the runtime may yield the fiber at any op boundary — so a
   * second caller can never mint a second refresh. A port rejection anywhere
   * in the attempt is a transient failure, logged here where its disposition
   * is decided.
   */
  readonly refreshSession = Effect.fn(
    'SupabaseSessionCoordinator.refreshSession',
  )(function* (
    this: SupabaseSessionCoordinator,
    session: SupabaseSession,
    expectedVersion: number = this.sessionMutationVersion,
  ) {
    const existing = this.refreshInFlight;
    if (existing) return yield* Deferred.await(existing);
    const inFlight = Deferred.makeUnsafe<SupabaseSession | null>();
    this.refreshInFlight = inFlight;
    this.lastRefreshFailure = null;
    return yield* this.performRefresh(session, expectedVersion).pipe(
      Effect.catchTag('AuthPortError', (error) => {
        this.lastRefreshFailure = 'transient';
        return Effect.logError(
          `Error refreshing session: ${toErrorMessage(error.cause)}`,
        ).pipe(withLogChannel(CHANNEL), Effect.as(null));
      }),
      Effect.onExit((exit) =>
        Effect.sync(() => {
          Deferred.doneUnsafe(inFlight, exit);
          if (this.refreshInFlight === inFlight) this.refreshInFlight = null;
        }),
      ),
    );
  });

  private readonly performRefresh = Effect.fn(
    'SupabaseSessionCoordinator.performRefresh',
  )(function* (
    this: SupabaseSessionCoordinator,
    session: SupabaseSession,
    expectedVersion: number,
  ) {
    const { data, error } = yield* callPort(() =>
      this.options.getClient().auth.refreshSession({
        refresh_token: session.refreshToken,
      }),
    );

    if (error || !data.session) {
      this.lastRefreshFailure = classifyAuthFailureStatus(error?.status);
      return null;
    }

    this.lastRefreshFailure = null;
    const refreshed = toStorableSupabaseSession(data.session);
    // Both decisions are made under the permit. Before the write: a mutation
    // that ran ahead of this refresh has bumped the version, and the
    // refreshed session must not overwrite what it wrote. After the write,
    // still under the permit: a mutation queued behind it has not bumped the
    // version yet but is about to replace what was just stored, so the
    // refreshed session is not the answer either — the caller gets the
    // post-mutation snapshot, as it did when the ledger checked after the
    // store.
    const current = yield* this.sessionMutations.run(
      Effect.suspend((): Effect.Effect<boolean, AuthPortError> => {
        if (this.sessionMutationVersion !== expectedVersion) {
          return Effect.succeed(false);
        }
        this.sessionMutationVersion += 1;
        return Effect.map(
          this.write(refreshed),
          () => !this.sessionMutations.hasWaiters,
        );
      }),
    );
    if (current) return refreshed;
    return (yield* this.stableSnapshot()).session;
  });

  /**
   * The stored session, refreshed if it is near expiry. A port rejection on
   * the read is a transient failure; refresh never fails.
   */
  private readonly freshSession = Effect.fn(
    'SupabaseSessionCoordinator.freshSession',
  )(function* (this: SupabaseSessionCoordinator) {
    const snapshot = yield* this.stableSnapshot().pipe(
      Effect.catchTag('AuthPortError', (error) => {
        this.lastRefreshFailure = 'transient';
        return Effect.logError(
          `Error loading fresh session: ${toErrorMessage(error.cause)}`,
        ).pipe(withLogChannel(CHANNEL), Effect.as(null));
      }),
    );
    if (!snapshot?.session) return null;
    const { session, version } = snapshot;

    const timeUntilExpiry =
      session.expiresAt - (yield* Clock.currentTimeMillis);

    if (timeUntilExpiry < this.options.tokenRefreshThresholdMs) {
      yield* Effect.logInfo(
        `Token expires in ${Math.round(timeUntilExpiry / 1000)}s, refreshing proactively`,
      ).pipe(withLogChannel(CHANNEL));
      const refreshed = yield* this.refreshSession(session, version);
      if (refreshed) return refreshed;
      if (timeUntilExpiry <= 0) {
        yield* Effect.logWarning(
          'Token expired and refresh failed, returning null',
        ).pipe(withLogChannel(CHANNEL));
        return null;
      }
    }

    this.lastRefreshFailure = null;
    return session;
  });

  private readonly storedSessionState = Effect.fn(
    'SupabaseSessionCoordinator.getStoredSessionState',
  )(function* (this: SupabaseSessionCoordinator) {
    for (;;) {
      const before = yield* this.stableSnapshot();
      if (!before.session) return 'none' as const;
      if (yield* this.freshSession()) return 'authenticated' as const;

      const after = yield* this.stableSnapshot();
      if (!after.session) return 'none' as const;
      if (after.version !== before.version) continue;

      return this.lastRefreshFailure === 'invalid'
        ? ('invalid' as const)
        : ('transient' as const);
    }
  });
}
