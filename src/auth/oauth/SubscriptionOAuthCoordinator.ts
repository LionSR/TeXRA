/**
 * Host-neutral coordinator for a subscription OAuth session (ChatGPT, Grok, …).
 *
 * Pure state machine over injected secret storage + network client. Provider
 * differences (authorize URL, claim extraction, refresh buffer) live in the
 * {@link SubscriptionOAuthPolicy}; this class owns single-flight refresh,
 * generation supersede, and serialized storage writes.
 *
 * Every method is an Effect program the caller yields or settles at its own
 * edge. Inside, the shared-machine {@link SubscriptionOAuthError} is the typed
 * failure and a port rejection travels as {@link AuthPortError}; the mutating
 * and refreshing programs re-mint both as the provider's own error type, so a
 * caller sees the same error vocabulary the retired Promise methods threw.
 */
// Third-party imports
import { Deferred, Effect, Result } from 'effect';

// Local imports
import { safeParseJson } from '@common/parsing/safeParseJson';
import { withLogChannel } from '@logger/effectLog';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { AuthPortError, SerializedWrites } from '../authProgram';
import { generateOAuthState, generatePkcePair } from './pkce';
import {
  toProviderAuthError,
  type ProviderAuthErrorCtor,
} from './providerAuthBridge';
import { SubscriptionOAuthError } from './subscriptionOAuthError';
import type { SubscriptionSessionBase } from './subscriptionSessionSchema';
import type { HttpClient } from 'effect/unstable/http';
import type { z } from 'zod';

const CHANNEL = 'SubscriptionOAuth';

/** Secret-backed persistence for one session bundle. */
export interface SubscriptionSessionStorage {
  get(): Effect.Effect<string | undefined, AuthPortError>;
  store(value: string): Effect.Effect<void, AuthPortError>;
  delete(): Effect.Effect<void, AuthPortError>;
}

/** Raw token-endpoint shape shared by authorization-code and refresh grants. */
export interface SubscriptionTokenResponse {
  access_token: string;
  refresh_token?: string | null;
  id_token?: string | null;
  expires_in: number;
}

/** Canonical stored session: the persisted base schema's shape (its single
 *  source of truth) plus the two optional identity fields the status read
 *  reports. Providers may add fields via intersection types. */
export type SubscriptionSession = SubscriptionSessionBase & {
  email?: string;
  accountId?: string;
};

export interface SubscriptionAuthorizeRequest {
  url: string;
  verifier: string;
  state: string;
  redirectUri: string;
}

/** Token grants compose in the calling fiber, including request cancellation. */
export interface SubscriptionOAuthClient {
  exchangeAuthorizationCode(params: {
    code: string;
    verifier: string;
    redirectUri: string;
  }): Effect.Effect<
    SubscriptionTokenResponse,
    SubscriptionOAuthError,
    HttpClient.HttpClient
  >;
  refreshTokens(
    refreshToken: string,
  ): Effect.Effect<
    SubscriptionTokenResponse,
    SubscriptionOAuthError,
    HttpClient.HttpClient
  >;
}

export interface SubscriptionSessionStatus {
  signedIn: boolean;
  email?: string;
  accountId?: string;
}

/**
 * Provider-specific policy. Keeps every magic URL/claim out of the shared
 * state machine.
 */
export interface SubscriptionOAuthPolicy<S extends SubscriptionSession> {
  /** Zod schema for the persisted session bundle. */
  readonly sessionSchema: z.ZodType<S>;
  /** Proactive refresh window (ms before expiresAtMs). */
  readonly refreshBufferMs: number;
  readonly notSignedInMessage: string;
  readonly sessionChangedMessage: string;
  /** Build authorize URL for a loopback bind on `port` (ignore if fixed). */
  buildAuthorizeRequest(
    port: number,
    pkce: { verifier: string; challenge: string; method: 'S256' },
    state: string,
  ): SubscriptionAuthorizeRequest;
  /** Map a token response into the stored session. */
  buildSession(
    tokens: SubscriptionTokenResponse,
    nowMs: number,
    previous?: S,
  ): S;
}

export interface SubscriptionOAuthCoordinatorInit<
  S extends SubscriptionSession,
> {
  storage: SubscriptionSessionStorage;
  policy: SubscriptionOAuthPolicy<S>;
  client: SubscriptionOAuthClient;
  /**
   * Wall clock for the expiry decision. It is not `Clock` (PRD R8) because
   * `isExpiringSoon` is a public synchronous method and the coordinator
   * suites fix the time by injecting it here; a `TestClock` would have to
   * reach the process runtime those suites run on. It converts when that
   * runtime's clock is injectable from a test.
   */
  now?: () => number;
  /**
   * Provider error type. The mutating/refreshing programs (loginWithCode,
   * storeTokens, getFreshAccessToken, getFreshSession) re-mint
   * {@link SubscriptionOAuthError} as this type so callers see the provider's
   * own error vocabulary.
   */
  errorType: ProviderAuthErrorCtor;
}

type MachineFailure = SubscriptionOAuthError | AuthPortError;

/**
 * A policy throw: the provider's own error (a
 * {@link SubscriptionOAuthError} subclass) stays first-class so the machine
 * can read its `kind`; anything else is that call's rejection.
 */
function asMachineFailure(cause: unknown): MachineFailure {
  return cause instanceof SubscriptionOAuthError
    ? cause
    : new AuthPortError({ cause });
}

export class SubscriptionOAuthCoordinator<S extends SubscriptionSession> {
  private readonly storage: SubscriptionSessionStorage;
  private readonly policy: SubscriptionOAuthPolicy<S>;
  private readonly client: SubscriptionOAuthClient;
  private readonly now: () => number;
  private readonly errorType: ProviderAuthErrorCtor;
  private refreshInFlight: Deferred.Deferred<S, MachineFailure> | null = null;
  private readonly sessionMutations = new SerializedWrites();
  private sessionGeneration = 0;

  constructor(init: SubscriptionOAuthCoordinatorInit<S>) {
    this.storage = init.storage;
    this.policy = init.policy;
    this.client = init.client;
    this.now = init.now ?? Date.now;
    this.errorType = init.errorType;
  }

  /** A program failure as the provider's own error type. */
  private readonly toProviderError = (error: MachineFailure): unknown =>
    toProviderAuthError(
      error instanceof AuthPortError ? error.cause : error,
      this.errorType,
    );

  /** The stored session, or null when signed out or unreadable. */
  readonly loadSession = Effect.fn('SubscriptionOAuthCoordinator.loadSession')(
    function* (this: SubscriptionOAuthCoordinator<S>) {
      const raw = yield* this.storage.get();
      if (!raw) return null;
      const parsedJson = safeParseJson(raw);
      if (Result.isFailure(parsedJson)) {
        // Present-but-corrupt is not the same as never signed in.
        yield* Effect.logWarning(
          `Stored subscription session is not valid JSON; treating as signed out: ${toErrorMessage(parsedJson.failure)}`,
        ).pipe(withLogChannel(CHANNEL));
        return null;
      }
      const parsed = this.policy.sessionSchema.safeParse(parsedJson.success);
      if (!parsed.success) {
        yield* Effect.logWarning(
          `Stored subscription session failed schema validation; treating as signed out: ${toErrorMessage(parsed.error)}`,
        ).pipe(withLogChannel(CHANNEL));
        return null;
      }
      return parsed.data;
    },
  );

  /** Signed-in status of the stored session. */
  getStatus(): Effect.Effect<SubscriptionSessionStatus, AuthPortError> {
    return Effect.map(this.loadSession(), (session) =>
      session
        ? {
            signedIn: true,
            email: session.email,
            accountId: session.accountId,
          }
        : { signedIn: false },
    );
  }

  buildAuthorizeRequest(port: number): SubscriptionAuthorizeRequest {
    const pkce = generatePkcePair();
    const state = generateOAuthState();
    return this.policy.buildAuthorizeRequest(port, pkce, state);
  }

  /**
   * The code exchange as a program: the loopback login yields it, so
   * interrupting that login reaches the exchange and the store. A machine
   * failure is re-minted as the provider's own error type; a port rejection
   * travels as its own cause.
   */
  loginWithCode(params: {
    code: string;
    verifier: string;
    redirectUri: string;
  }): Effect.Effect<S, unknown, HttpClient.HttpClient> {
    return Effect.mapError(this.exchangeCode(params), this.toProviderError);
  }

  /** Persist tokens from a successful device-code (or other) grant. */
  storeTokens(tokens: SubscriptionTokenResponse): Effect.Effect<S, unknown> {
    return Effect.mapError(this.adoptTokens(tokens), this.toProviderError);
  }

  isExpiringSoon(session: S): boolean {
    return this.now() + this.policy.refreshBufferMs >= session.expiresAtMs;
  }

  /** The access token of the stored session, refreshed when expiring soon. */
  getFreshAccessToken(): Effect.Effect<string, unknown, HttpClient.HttpClient> {
    return Effect.mapError(
      Effect.map(this.freshSession(), (session) => session.accessToken),
      this.toProviderError,
    );
  }

  /** The stored session, refreshed when expiring soon. */
  getFreshSession(): Effect.Effect<S, unknown, HttpClient.HttpClient> {
    return Effect.mapError(this.freshSession(), this.toProviderError);
  }

  private store(session: S): Effect.Effect<void, AuthPortError> {
    return this.storage.store(JSON.stringify(session));
  }

  private buildSession(
    tokens: SubscriptionTokenResponse,
    previous?: S,
  ): Effect.Effect<S, MachineFailure> {
    return Effect.try({
      try: () => this.policy.buildSession(tokens, this.now(), previous),
      catch: asMachineFailure,
    });
  }

  private readonly stableSession = Effect.fn(
    'SubscriptionOAuthCoordinator.stableSession',
  )(function* (this: SubscriptionOAuthCoordinator<S>) {
    for (;;) {
      const generation = this.sessionGeneration;
      // A mutation that starts after the barrier bumps the generation and
      // re-loops.
      yield* this.sessionMutations.awaitIdle();
      const session = yield* this.loadSession();
      if (generation === this.sessionGeneration) {
        return { generation, session };
      }
    }
  });

  /** Passed to `SerializedWrites.run` so it shares the queueing segment. */
  private readonly supersedeInFlightRefresh = (): void => {
    this.sessionGeneration += 1;
    this.refreshInFlight = null;
  };

  /**
   * After a refresh is superseded (concurrent login/sign-out), take a stable
   * storage snapshot and:
   * - return a *replacement* session (different credentials) — concurrent
   *   sign-in succeeded; do not force re-auth;
   * - return a still-fresh same session (rare: supersede without replace);
   * - fail `expired` when storage is empty (sign-out won);
   * - fail `transient` when the pre-refresh session is still the only
   *   stored value and still needs refresh (failed concurrent store, or a
   *   server-rotated refresh that never landed) — never hand back a known-
   *   stale token as if the refresh completed.
   */
  private readonly sessionAfterSupersede = Effect.fn(
    'SubscriptionOAuthCoordinator.sessionAfterSupersede',
  )(function* (this: SubscriptionOAuthCoordinator<S>, previous: S) {
    const { session } = yield* this.stableSession();
    if (!session) {
      return yield* Effect.fail(
        new SubscriptionOAuthError(
          this.policy.sessionChangedMessage,
          'expired',
        ),
      );
    }
    const replaced =
      session.accessToken !== previous.accessToken ||
      session.refreshToken !== previous.refreshToken;
    if (replaced || !this.isExpiringSoon(session)) {
      return session;
    }
    return yield* Effect.fail(
      new SubscriptionOAuthError(
        this.policy.sessionChangedMessage,
        'transient',
      ),
    );
  });

  /** Delete the stored session, superseding any refresh in flight. */
  readonly signOut = Effect.fn('SubscriptionOAuthCoordinator.signOut')(
    function* (this: SubscriptionOAuthCoordinator<S>) {
      yield* this.sessionMutations.run(
        this.storage.delete(),
        this.supersedeInFlightRefresh,
      );
    },
  );

  /** Make the session for a fresh grant the stored one, superseding any refresh in flight. */
  private readonly adoptTokens = Effect.fn(
    'SubscriptionOAuthCoordinator.adoptTokens',
  )(function* (
    this: SubscriptionOAuthCoordinator<S>,
    tokens: SubscriptionTokenResponse,
  ) {
    const session = yield* this.buildSession(tokens);
    yield* this.sessionMutations.run(
      this.store(session),
      this.supersedeInFlightRefresh,
    );
    return session;
  });

  private readonly exchangeCode = Effect.fn(
    'SubscriptionOAuthCoordinator.loginWithCode',
  )(function* (
    this: SubscriptionOAuthCoordinator<S>,
    params: { code: string; verifier: string; redirectUri: string },
  ) {
    const tokens = yield* this.client.exchangeAuthorizationCode(params);
    return yield* this.adoptTokens(tokens);
  });

  private readonly freshSession = Effect.fn(
    'SubscriptionOAuthCoordinator.getFreshSession',
  )(function* (this: SubscriptionOAuthCoordinator<S>) {
    const { generation, session } = yield* this.stableSession();
    if (!session) {
      return yield* Effect.fail(
        new SubscriptionOAuthError(this.policy.notSignedInMessage, 'expired'),
      );
    }
    if (!this.isExpiringSoon(session)) return session;
    return yield* this.refresh(session, generation);
  });

  /**
   * Single-flight refresh: concurrent callers share the in-flight result. The
   * check and the claim share one synchronous segment — no `yield*` between
   * them, since the runtime may yield the fiber at any op boundary — so a
   * second caller can never mint a second refresh.
   */
  private readonly refresh = Effect.fn('SubscriptionOAuthCoordinator.refresh')(
    function* (
      this: SubscriptionOAuthCoordinator<S>,
      previous: S,
      generation: number,
    ) {
      const existing = this.refreshInFlight;
      if (existing) return yield* Deferred.await(existing);
      const inFlight = Deferred.makeUnsafe<S, MachineFailure>();
      this.refreshInFlight = inFlight;
      return yield* this.performRefresh(previous, generation).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            Deferred.doneUnsafe(inFlight, exit);
            if (this.refreshInFlight === inFlight) this.refreshInFlight = null;
          }),
        ),
      );
    },
  );

  private readonly performRefresh = Effect.fn(
    'SubscriptionOAuthCoordinator.performRefresh',
  )(function* (
    this: SubscriptionOAuthCoordinator<S>,
    previous: S,
    generation: number,
  ) {
    const tokens = yield* this.client.refreshTokens(previous.refreshToken).pipe(
      // A fatal rejection means the stored session is dead: clear it, unless
      // a concurrent login or sign-out already replaced it.
      Effect.tapError((error) =>
        error instanceof SubscriptionOAuthError && error.kind === 'fatal'
          ? this.sessionMutations.run(
              Effect.suspend(() =>
                generation === this.sessionGeneration
                  ? this.storage.delete()
                  : Effect.void,
              ),
            )
          : Effect.void,
      ),
    );
    const session = yield* this.buildSession(tokens, previous);
    yield* this.sessionMutations.run(
      Effect.suspend(() =>
        generation === this.sessionGeneration
          ? this.store(session)
          : Effect.void,
      ),
    );
    if (generation === this.sessionGeneration) return session;
    return yield* this.sessionAfterSupersede(previous);
  });
}
