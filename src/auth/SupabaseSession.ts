import { Clock, Deferred, Effect } from 'effect';

import { toErrorMessage } from '@utils/errors/errorMessage';
import {
  parseAuthCallbackCode,
  type AuthCallbackUriParts,
} from './authCallback';
import {
  callPort,
  runAuthProgram,
  SerializedWrites,
  type AuthPortError,
} from './authProgram';
import {
  parseStoredSupabaseSession,
  toStorableSupabaseSession,
  type SupabaseCallbackResult,
  type SupabaseSession,
  type SupabaseSessionLog,
  type SupabaseSessionStorage,
} from './supabaseSessionTypes';
import {
  classifyAuthFailureStatus,
  type AuthTokenProvider,
  type SessionRefreshFailure,
  type SessionTokens,
  type StoredSessionState,
} from './TokenProvider';
import type { SupabaseClient as Client } from '@supabase/supabase-js';

// Public entry point for the session value-object helpers and coordinator.
// Only the symbols consumers actually use are forwarded; the Zod schemas and
// callback/parse option types stay internal to `supabaseSessionTypes`.
export {
  DEFAULT_SUPABASE_SESSION_EXPIRY_MS,
  GitHubTokenExchangeSchema,
  parseStoredSupabaseSession,
  toStorableSupabaseSession,
  type SupabaseCallbackResult,
  type SupabaseSession,
  type SupabaseSessionLog,
  type SupabaseSessionStorage,
} from './supabaseSessionTypes';

export interface SupabaseSessionCoordinatorOptions {
  storage: SupabaseSessionStorage;
  getClient: () => Client;
  whenReady: () => Promise<void>;
  tokenRefreshThresholdMs: number;
  log?: SupabaseSessionLog;
}

const NOOP_SUPABASE_SESSION_LOG: Required<SupabaseSessionLog> = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Host-neutral coordinator for Supabase session storage, token freshness,
 * OAuth callback conversion, and refresh. Host wrappers own UI and registration.
 *
 * The Promise methods are the boundary; each runs one of the Effect programs
 * below through {@link runAuthProgram}. Storage and GoTrue rejections travel
 * as {@link AuthPortError} and reach the caller as the port's own error.
 */
export class SupabaseSessionCoordinator implements AuthTokenProvider {
  private refreshInFlight: Deferred.Deferred<SupabaseSession | null> | null =
    null;
  private sessionMutationVersion = 0;
  private lastRefreshFailure: SessionRefreshFailure | null = null;
  // Serialized writes, same mechanism as SubscriptionOAuthCoordinator's
  // `sessionMutations`: every write bumps `sessionMutationVersion` under the
  // permit, so its idle barrier plus a version recheck is `stableSnapshot`'s
  // "no mutation in flight, and none started during the read" guarantee.
  private readonly sessionMutations = new SerializedWrites();
  private readonly log: Required<SupabaseSessionLog>;

  constructor(private readonly options: SupabaseSessionCoordinatorOptions) {
    this.log = { ...NOOP_SUPABASE_SESSION_LOG, ...options.log };
  }

  async whenReady(): Promise<void> {
    await this.options.whenReady();
  }

  async loadSession(): Promise<SupabaseSession | null> {
    return runAuthProgram(this.load());
  }

  async storeSession(session: SupabaseSession): Promise<void> {
    await runAuthProgram(this.mutate(this.write(session)));
  }

  async clearSession(): Promise<void> {
    await runAuthProgram(
      this.mutate(callPort(() => this.options.storage.delete())),
    );
  }

  /**
   * Clear the stored session only if it still has the credential pair observed
   * by the caller. A completed OAuth callback or refresh may replace a session
   * while an older validation request is in flight; that older result must not
   * delete the replacement.
   */
  async clearSessionIfCurrent(expected: SupabaseSession): Promise<boolean> {
    return runAuthProgram(
      this.sessionMutations.run(this.clearIfCurrent(expected)),
    );
  }

  /**
   * Ensure the access token is fresh, refreshing proactively if near expiry.
   *
   * @returns Fresh access token, or null if no session or refresh failed.
   */
  async ensureFreshToken(): Promise<string | null> {
    return runAuthProgram(
      Effect.map(
        this.freshSession(),
        (session) => session?.accessToken ?? null,
      ),
    );
  }

  /**
   * Classify one stable stored-session generation. A callback may replace the
   * session while refresh is in flight; in that case retry rather than apply
   * the old credential's failure to the new one.
   */
  async getStoredSessionState(): Promise<StoredSessionState> {
    return runAuthProgram(
      this.storedSessionState().pipe(
        Effect.catchTag('AuthPortError', (error) =>
          Effect.sync(() => {
            this.log.error(
              'SupabaseSession',
              `Error classifying stored session: ${toErrorMessage(error.cause)}`,
            );
            return 'transient' as const;
          }),
        ),
      ),
    );
  }

  /**
   * Read the stored session's account label without attempting a token
   * refresh. Returns null when no session is stored or the data is
   * unreadable — the caller decides what to show in its place.
   */
  async getStoredAccountLabel(): Promise<string | null> {
    return runAuthProgram(
      Effect.map(this.load(), (session) => session?.account.label ?? null),
    );
  }

  getLastRefreshFailure(): SessionRefreshFailure | null {
    return this.lastRefreshFailure;
  }

  /** Get access and refresh tokens from secure storage. */
  async getSessionTokens(): Promise<SessionTokens | null> {
    return runAuthProgram(
      Effect.map(this.freshSession(), (session) =>
        session
          ? {
              accessToken: session.accessToken,
              refreshToken: session.refreshToken,
            }
          : null,
      ),
    );
  }

  /** Convert a PKCE OAuth callback into a host-neutral session record. */
  async createSessionFromCallback(
    uri: AuthCallbackUriParts,
    flowId?: string,
  ): Promise<SupabaseCallbackResult> {
    const parsedCode = parseAuthCallbackCode(uri);
    return parsedCode.success
      ? runAuthProgram(this.exchangeCode(parsedCode.code, flowId))
      : parsedCode;
  }

  /** Refresh session via Supabase native refresh, with concurrency protection. */
  async refreshSession(
    session: SupabaseSession,
    expectedVersion = this.sessionMutationVersion,
  ): Promise<SupabaseSession | null> {
    return runAuthProgram(this.refresh(session, expectedVersion));
  }

  /** Read and parse the stored session. */
  private readonly load = Effect.fn('SupabaseSessionCoordinator.load')(
    function* (this: SupabaseSessionCoordinator) {
      const raw = yield* callPort(() => this.options.storage.get());
      return parseStoredSupabaseSession(raw, {
        logSource: 'SupabaseSession',
        warn: this.log.warn,
      });
    },
  );

  private write(session: SupabaseSession): Effect.Effect<void, AuthPortError> {
    return callPort(() => this.options.storage.store(JSON.stringify(session)));
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
    const current = yield* this.load();
    if (
      !current ||
      current.accessToken !== expected.accessToken ||
      current.refreshToken !== expected.refreshToken
    ) {
      return false;
    }
    this.sessionMutationVersion += 1;
    yield* callPort(() => this.options.storage.delete());
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
      const session = yield* this.load();
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
  private readonly refresh = Effect.fn(
    'SupabaseSessionCoordinator.refreshSession',
  )(function* (
    this: SupabaseSessionCoordinator,
    session: SupabaseSession,
    expectedVersion: number,
  ) {
    const existing = this.refreshInFlight;
    if (existing) return yield* Deferred.await(existing);
    const inFlight = Deferred.makeUnsafe<SupabaseSession | null>();
    this.refreshInFlight = inFlight;
    this.lastRefreshFailure = null;
    return yield* this.performRefresh(session, expectedVersion).pipe(
      Effect.catchTag('AuthPortError', (error) =>
        Effect.sync(() => {
          this.lastRefreshFailure = 'transient';
          this.log.error(
            'SupabaseSession',
            `Error refreshing session: ${toErrorMessage(error.cause)}`,
          );
          return null;
        }),
      ),
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
      Effect.catchTag('AuthPortError', (error) =>
        Effect.sync(() => {
          this.lastRefreshFailure = 'transient';
          this.log.error(
            'SupabaseSession',
            `Error loading fresh session: ${toErrorMessage(error.cause)}`,
          );
          return null;
        }),
      ),
    );
    if (!snapshot?.session) return null;
    const { session, version } = snapshot;

    const timeUntilExpiry =
      session.expiresAt - (yield* Clock.currentTimeMillis);

    if (timeUntilExpiry < this.options.tokenRefreshThresholdMs) {
      this.log.info(
        'SupabaseSession',
        `Token expires in ${Math.round(timeUntilExpiry / 1000)}s, refreshing proactively`,
      );
      const refreshed = yield* this.refresh(session, version);
      if (refreshed) return refreshed;
      if (timeUntilExpiry <= 0) {
        this.log.warn(
          'SupabaseSession',
          'Token expired and refresh failed, returning null',
        );
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
