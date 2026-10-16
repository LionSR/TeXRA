/**
 * Host-neutral coordinator for a subscription OAuth session (ChatGPT, Grok, …).
 *
 * Pure state machine over injected secret storage + network client. Provider
 * differences (authorize URL, claim extraction) live in the
 * {@link SubscriptionOAuthPolicy}; this class owns single-flight refresh,
 * generation supersede, and serialized storage writes.
 *
 * Every method is an Effect program the caller yields or settles at its own
 * edge. A program fails with {@link SubscriptionOAuthError} or with the
 * secret store's own {@link SecretsFailed}.
 */
// Third-party imports
import { Effect, Result } from 'effect';

// Local imports
import { SharedAttempt } from './sharedAttempt.js';
import { ensureError, LOG_CHANNEL, toErrorMessage } from './support.js';

import { SerializedWrites } from './authProgram.js';
import {
  exchangeAuthorizationCode,
  refreshOAuthTokens,
  type OAuthFormEndpoint,
} from './formTokenClient.js';
import { authorizeRequest } from './pkce.js';
import { SubscriptionOAuthError } from './subscriptionOAuthError.js';
import type { OAuthRequestError } from './oauthRequest.js';
import type { SecretsFailed } from '../providers/credentials.js';
import type {
  SubscriptionAuthorizeRequest,
  SubscriptionCoordinator,
  SubscriptionSession,
  SubscriptionSessionStatus,
  SubscriptionTokenResponse,
} from './subscriptionCoordinator.js';
import type { HttpClient } from 'effect/http';
import type { z } from 'zod';

const CHANNEL = 'SubscriptionOAuth';

/** Secret-backed persistence for one session bundle. */
export interface SubscriptionSessionStorage {
  get(): Effect.Effect<string | undefined, SecretsFailed>;
  store(value: string): Effect.Effect<void, SecretsFailed>;
  delete(): Effect.Effect<void, SecretsFailed>;
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

/**
 * Provider-specific policy. Keeps every magic URL/claim out of the shared
 * state machine.
 */
export interface SubscriptionOAuthPolicy<S extends SubscriptionSession> {
  /** Zod schema for the persisted session bundle. */
  readonly sessionSchema: z.ZodType<S>;
  /** Form token endpoint the default client grants against. */
  readonly tokenEndpoint: OAuthFormEndpoint;
  readonly notSignedInMessage: string;
  readonly sessionChangedMessage: string;
  /** The provider's authorize endpoint, for the PKCE code flow (`./pkce.ts`). */
  readonly authorize: {
    readonly url: string;
    readonly scope: string;
    /** The loopback redirect for a bind on `port` (a pinned one ignores it). */
    redirectUri(port: number): string;
    /** The provider's parameters beyond the code flow's own. */
    readonly params: Readonly<Record<string, string>>;
  };
  /** Token response to session. Must not throw: it runs in `Effect.succeed`. */
  buildSession(
    tokens: SubscriptionTokenResponse,
    refreshToken: string,
    nowMs: number,
    previous?: S,
  ): S;
}

export interface SubscriptionOAuthCoordinatorInit<
  S extends SubscriptionSession,
> {
  storage: SubscriptionSessionStorage;
  policy: SubscriptionOAuthPolicy<S>;
  /** Token grants; defaults to the policy's form endpoint. */
  client?: SubscriptionOAuthClient;
  /** Wall clock, in epoch milliseconds, for the expiry decision; defaults to
   *  `Date.now`. */
  // Not Effect's `Clock`: the coordinator suites fix the time by injecting
  // it here, and a `TestClock` would have to reach the process runtime those
  // suites run on.
  now?: () => number;
}

type MachineFailure = SubscriptionOAuthError | SecretsFailed;

/** Refresh this long before expiry (the Codex CLI's and Zed's buffer). */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * A token-grant request failure as the machine's error: the same message,
 * kind, and status the grant's Promise API always threw.
 */
function grantFailure(error: OAuthRequestError): SubscriptionOAuthError {
  switch (error._tag) {
    case 'OAuthHttpError':
      return new SubscriptionOAuthError({
        message: error.message,
        kind: error.kind,
        status: error.status,
      });
    case 'OAuthNetworkError':
    case 'OAuthUnexpectedResponse':
      return new SubscriptionOAuthError({
        message: error.message,
        kind: 'transient',
        cause: error.cause,
      });
  }
}

/** The form-grant client over a policy's token endpoint. */
function formGrantClient(endpoint: OAuthFormEndpoint): SubscriptionOAuthClient {
  return {
    exchangeAuthorizationCode: (params) =>
      Effect.mapError(
        exchangeAuthorizationCode(endpoint, params),
        grantFailure,
      ),
    refreshTokens: (refreshToken) =>
      Effect.mapError(refreshOAuthTokens(endpoint, refreshToken), grantFailure),
  };
}

/** The {@link SubscriptionCoordinator} over a provider's policy. */
export class SubscriptionOAuthCoordinator<
  S extends SubscriptionSession,
> implements SubscriptionCoordinator<S> {
  private readonly storage: SubscriptionSessionStorage;
  private readonly policy: SubscriptionOAuthPolicy<S>;
  private readonly client: SubscriptionOAuthClient;
  private readonly now: () => number;
  private readonly refreshes = new SharedAttempt<S, MachineFailure>();
  private readonly sessionMutations = new SerializedWrites();
  private sessionGeneration = 0;

  constructor(init: SubscriptionOAuthCoordinatorInit<S>) {
    this.storage = init.storage;
    this.policy = init.policy;
    this.client = init.client ?? formGrantClient(init.policy.tokenEndpoint);
    this.now = init.now ?? Date.now;
  }

  /** The stored session, or null when signed out or unreadable. */
  readonly loadSession = Effect.fn('SubscriptionOAuthCoordinator.loadSession')(
    function* (this: SubscriptionOAuthCoordinator<S>) {
      const raw = yield* this.storage.get();
      if (!raw) return null;
      const parsedJson = Result.try({
        try: () => JSON.parse(raw) as unknown,
        catch: ensureError,
      });
      if (Result.isFailure(parsedJson)) {
        // Present-but-corrupt is not the same as never signed in.
        yield* Effect.logWarning(
          `Stored subscription session is not valid JSON; treating as signed out: ${toErrorMessage(parsedJson.failure)}`,
        ).pipe(Effect.annotateLogs({ [LOG_CHANNEL]: CHANNEL }));
        return null;
      }
      const parsed = this.policy.sessionSchema.safeParse(parsedJson.success);
      if (!parsed.success) {
        yield* Effect.logWarning(
          `Stored subscription session failed schema validation; treating as signed out: ${toErrorMessage(parsed.error)}`,
        ).pipe(Effect.annotateLogs({ [LOG_CHANNEL]: CHANNEL }));
        return null;
      }
      return parsed.data;
    },
  );

  /** Signed-in status of the stored session. */
  getStatus(): Effect.Effect<SubscriptionSessionStatus, SecretsFailed> {
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
    return authorizeRequest(this.policy, port);
  }

  private isExpiringSoon(session: S): boolean {
    return this.now() + REFRESH_BUFFER_MS >= session.expiresAtMs;
  }

  /** The stored session, refreshed when expiring soon. */
  getFreshSession(): Effect.Effect<S, Error, HttpClient.HttpClient> {
    return this.freshSession(false);
  }

  /**
   * Refresh the stored session now, whatever its stored expiry: the provider
   * rejected its access token early (revoked, or expired server-side). A
   * fatal refresh clears the session, so the account reads as signed out.
   */
  refreshRejected(): Effect.Effect<void, Error, HttpClient.HttpClient> {
    return Effect.asVoid(this.freshSession(true));
  }

  private store(session: S): Effect.Effect<void, SecretsFailed> {
    return this.storage.store(JSON.stringify(session));
  }

  private buildSession(
    tokens: SubscriptionTokenResponse,
    previous?: S,
  ): Effect.Effect<S, SubscriptionOAuthError> {
    const refreshToken = tokens.refresh_token ?? previous?.refreshToken;
    return refreshToken
      ? Effect.succeed(
          this.policy.buildSession(tokens, refreshToken, this.now(), previous),
        )
      : Effect.fail(
          new SubscriptionOAuthError({
            message: 'OAuth response did not include a refresh token.',
            kind: 'config',
          }),
        );
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
    this.refreshes.clear();
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
        new SubscriptionOAuthError({
          message: this.policy.sessionChangedMessage,
          kind: 'expired',
        }),
      );
    }
    const replaced =
      session.accessToken !== previous.accessToken ||
      session.refreshToken !== previous.refreshToken;
    if (replaced || !this.isExpiringSoon(session)) {
      return session;
    }
    return yield* Effect.fail(
      new SubscriptionOAuthError({
        message: this.policy.sessionChangedMessage,
        kind: 'transient',
      }),
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

  /**
   * Persist tokens from a successful device-code (or other) grant: the
   * session built from them becomes the stored one, superseding any refresh
   * in flight.
   */
  readonly storeTokens = Effect.fn('SubscriptionOAuthCoordinator.storeTokens')(
    function* (
      this: SubscriptionOAuthCoordinator<S>,
      tokens: SubscriptionTokenResponse,
    ) {
      const session = yield* this.buildSession(tokens);
      yield* this.sessionMutations.run(
        this.store(session),
        this.supersedeInFlightRefresh,
      );
      return session;
    },
  );

  /**
   * The code exchange as a program: the loopback login yields it, so
   * interrupting that login reaches the exchange and the store.
   */
  readonly loginWithCode = Effect.fn(
    'SubscriptionOAuthCoordinator.loginWithCode',
  )(function* (
    this: SubscriptionOAuthCoordinator<S>,
    params: { code: string; verifier: string; redirectUri: string },
  ) {
    const tokens = yield* this.client.exchangeAuthorizationCode(params);
    return yield* this.storeTokens(tokens);
  });

  private readonly freshSession = Effect.fn(
    'SubscriptionOAuthCoordinator.getFreshSession',
  )(function* (this: SubscriptionOAuthCoordinator<S>, force: boolean) {
    const { generation, session } = yield* this.stableSession();
    if (!session) {
      return yield* Effect.fail(
        new SubscriptionOAuthError({
          message: this.policy.notSignedInMessage,
          kind: 'expired',
        }),
      );
    }
    if (!force && !this.isExpiringSoon(session)) return session;
    return yield* this.refresh(session, generation);
  });

  /**
   * Single-flight refresh: concurrent callers share one attempt, which runs
   * detached ({@link SharedAttempt}), so an interrupted caller abandons only
   * its own wait and a rotated refresh token is still stored.
   */
  private refresh(
    previous: S,
    generation: number,
  ): Effect.Effect<S, MachineFailure, HttpClient.HttpClient> {
    return this.refreshes.run(() => this.performRefresh(previous, generation));
  }

  private readonly performRefresh = Effect.fn(
    'SubscriptionOAuthCoordinator.performRefresh',
  )(function* (
    this: SubscriptionOAuthCoordinator<S>,
    previous: S,
    generation: number,
  ) {
    const tokens = yield* this.client.refreshTokens(previous.refreshToken).pipe(
      // Fatal: clear the session unless a login or a refresh replaced it.
      Effect.tapError((error) =>
        error instanceof SubscriptionOAuthError && error.kind === 'fatal'
          ? this.sessionMutations.run(
              Effect.flatMap(this.loadSession(), (stored) =>
                stored?.refreshToken !== previous.refreshToken ||
                generation !== this.sessionGeneration
                  ? Effect.void
                  : this.storage.delete(),
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
