/**
 * Host-neutral coordinator for a subscription OAuth session (ChatGPT, Grok, …).
 *
 * Pure state machine over injected secret storage. Provider
 * differences (authorize URL, claim extraction) live in the
 * {@link SubscriptionOAuthPolicy}; this class owns single-flight refresh,
 * generation supersede, and serialized storage writes.
 *
 * Every method is an Effect program the caller yields or runs at its own
 * edge. A program fails with {@link SubscriptionOAuthError} or with the
 * secret store's own {@link SecretsFailed}.
 */
// Third-party imports
import { Clock, Effect, Result, Schema } from 'effect';

// Local imports
import { SharedAttempt } from './sharedAttempt.js';
import { toErrorMessage } from './support.js';

import { SerializedWrites } from './authProgram.js';
import {
  exchangeAuthorizationCode,
  refreshOAuthTokens,
} from './formTokenClient.js';
import { authorizeRequest } from './pkce.js';
import { SubscriptionOAuthError } from './subscriptionOAuthError.js';
import type { OAuthRequestError } from './oauthRequest.js';
import type {
  CredentialStore,
  SecretsFailed,
} from '../providers/credentials.js';
import type {
  SubscriptionAuthorizeRequest,
  SubscriptionCallback,
  SubscriptionCoordinator,
  SubscriptionOAuthPolicy,
  SubscriptionSession,
  SubscriptionSessionStatus,
  SubscriptionTokenResponse,
} from './subscriptionCoordinator.js';
import type { HttpClient } from 'effect/http';

type MachineFailure = SubscriptionOAuthError | SecretsFailed;

/** Refresh this long before expiry (the Codex CLI's and Zed's buffer). */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

/** A token-grant failure as the machine's error: the same message, kind
 *  and status the grant's Promise API always threw. */
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

/** The {@link SubscriptionCoordinator} over a provider's policy. */
export class SubscriptionOAuthCoordinator<
  S extends SubscriptionSession,
> implements SubscriptionCoordinator<S> {
  /**
   * One coordinator per credential store for this provider. Refresh tokens
   * may rotate on use, so callers sharing a store must share the same refresh
   * attempt and write queue. Replacing the store starts an independent one.
   */
  static forProvider<S extends SubscriptionSession>(
    policy: SubscriptionOAuthPolicy<S>,
  ): (secrets: CredentialStore) => SubscriptionCoordinator<S> {
    const coordinators = new WeakMap<
      CredentialStore,
      SubscriptionCoordinator<S>
    >();
    return (secrets) => {
      let coordinator = coordinators.get(secrets);
      if (coordinator === undefined) {
        coordinator = new SubscriptionOAuthCoordinator(secrets, policy);
        coordinators.set(secrets, coordinator);
      }
      return coordinator;
    };
  }

  private readonly secrets: CredentialStore;
  private readonly policy: SubscriptionOAuthPolicy<S>;
  private readonly refreshes = new SharedAttempt<S, MachineFailure>();
  private readonly sessionMutations = new SerializedWrites();
  private sessionGeneration = 0;

  private constructor(
    secrets: CredentialStore,
    policy: SubscriptionOAuthPolicy<S>,
  ) {
    this.secrets = secrets;
    this.policy = policy;
  }

  /**
   * The stored session, or null when none is stored. A stored session that
   * does not parse is not "never signed in": it fails `fatal`, so the
   * caller asks for a fresh sign-in, which overwrites it.
   */
  readonly loadSession = Effect.fn('SubscriptionOAuthCoordinator.loadSession')(
    function* (
      this: SubscriptionOAuthCoordinator<S>,
    ): Effect.fn.Return<S | null, SecretsFailed | SubscriptionOAuthError> {
      const raw = yield* this.secrets.get(this.policy.secretKey);
      if (!raw) return null;
      const parsed = Schema.decodeUnknownResult(
        Schema.fromJsonString(this.policy.sessionSchema),
      )(raw);
      if (Result.isSuccess(parsed)) return parsed.success;
      return yield* new SubscriptionOAuthError({
        message: `The stored subscription session is unreadable; sign in again: ${toErrorMessage(parsed.failure)}`,
        kind: 'fatal',
      });
    },
  );

  /** Signed-in status of the stored session. */
  getStatus(): Effect.Effect<
    SubscriptionSessionStatus,
    SecretsFailed | SubscriptionOAuthError
  > {
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

  readonly buildAuthorizeRequest = Effect.fn(
    'SubscriptionOAuthCoordinator.buildAuthorizeRequest',
  )(function* (this: SubscriptionOAuthCoordinator<S>, port: number) {
    const { registration } = this.policy;
    return authorizeRequest(
      this.policy,
      port,
      registration &&
        (yield* registration(yield* this.loadSession(), this.secrets)),
    );
  });

  /** Whether `session` needs a refresh at `now`, a `Clock` reading. */
  private isExpiringSoon(session: S, now: number): boolean {
    return now + REFRESH_BUFFER_MS >= session.expiresAtMs;
  }

  /** The stored session, refreshed when expiring soon. */
  getFreshSession(): Effect.Effect<S, Error, HttpClient.HttpClient> {
    return this.freshSession();
  }

  /**
   * The provider rejected `token` early (revoked, or expired server-side):
   * refresh while the stored session still holds it, so calls that sent one
   * token rotate it once. A fatal refresh clears the session.
   */
  refreshRejected(
    token: string,
  ): Effect.Effect<void, Error, HttpClient.HttpClient> {
    return Effect.asVoid(this.freshSession(token));
  }

  private store(session: S): Effect.Effect<void, SecretsFailed> {
    return this.secrets.set(this.policy.secretKey, JSON.stringify(session));
  }

  private buildSession(
    tokens: SubscriptionTokenResponse,
    previous?: S,
    clientId: string | undefined = previous?.clientId,
  ): Effect.Effect<S, SubscriptionOAuthError> {
    const refreshToken = tokens.refresh_token ?? previous?.refreshToken;
    return refreshToken
      ? Effect.map(Clock.currentTimeMillis, (now) => {
          const session = this.policy.buildSession(
            tokens,
            refreshToken,
            now,
            previous,
          );
          return clientId === undefined ? session : { ...session, clientId };
        })
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
      // A mutation after the barrier bumps the generation: re-loop.
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
    if (
      replaced ||
      !this.isExpiringSoon(session, yield* Clock.currentTimeMillis)
    ) {
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
        this.secrets.delete(this.policy.secretKey),
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
      clientId?: string,
    ) {
      const session = yield* this.buildSession(tokens, undefined, clientId);
      yield* this.sessionMutations.run(
        this.store(session),
        this.supersedeInFlightRefresh,
      );
      return session;
    },
  );

  /**
   * The code exchange as a program: the loopback login yields it, so
   * interrupting that login reaches the exchange and the store. A
   * registering attempt takes the client the callback names; a returning
   * one rejects a callback that names another.
   */
  readonly loginWithCode = Effect.fn(
    'SubscriptionOAuthCoordinator.loginWithCode',
  )(function* (
    this: SubscriptionOAuthCoordinator<S>,
    request: SubscriptionAuthorizeRequest,
    callback: SubscriptionCallback,
  ) {
    const clientId = request.registering ? callback.clientId : request.clientId;
    if (
      clientId === undefined ||
      (callback.clientId !== undefined && callback.clientId !== clientId)
    ) {
      return yield* new SubscriptionOAuthError({
        message: 'Sign-in did not confirm the client it used. Sign in again.',
        kind: 'config',
      });
    }
    const tokens = yield* Effect.mapError(
      exchangeAuthorizationCode(this.policy.tokenEndpoint, {
        code: callback.code,
        verifier: request.verifier,
        redirectUri: request.redirectUri,
        clientId,
      }),
      grantFailure,
    );
    if (this.policy.acceptGrant)
      yield* this.policy.acceptGrant(tokens, clientId, request.nonce);
    return yield* this.storeTokens(tokens, clientId);
  });

  private readonly freshSession = Effect.fn(
    'SubscriptionOAuthCoordinator.getFreshSession',
  )(function* (this: SubscriptionOAuthCoordinator<S>, rejected?: string) {
    const { generation, session } = yield* this.stableSession();
    if (!session) {
      return yield* Effect.fail(
        new SubscriptionOAuthError({
          message: this.policy.notSignedInMessage,
          kind: 'expired',
        }),
      );
    }
    if (
      session.accessToken !== rejected &&
      !this.isExpiringSoon(session, yield* Clock.currentTimeMillis)
    )
      return session;
    // Single-flight refresh: concurrent callers share one attempt, which runs
    // detached (`SharedAttempt`), so an interrupted caller abandons only
    // its own wait and a rotated refresh token is still stored.
    return yield* this.refreshes.run(() =>
      this.performRefresh(session, generation),
    );
  });

  private readonly performRefresh = Effect.fn(
    'SubscriptionOAuthCoordinator.performRefresh',
  )(function* (
    this: SubscriptionOAuthCoordinator<S>,
    previous: S,
    generation: number,
  ) {
    const tokens = yield* refreshOAuthTokens(
      this.policy.tokenEndpoint,
      previous.refreshToken,
      previous.clientId ?? this.policy.tokenEndpoint.clientId,
    ).pipe(
      Effect.mapError(grantFailure),
      // Fatal: clear the session unless a login or a refresh replaced it.
      Effect.tapError((error) =>
        error instanceof SubscriptionOAuthError && error.kind === 'fatal'
          ? this.sessionMutations.run(
              Effect.flatMap(this.loadSession(), (stored) =>
                stored?.refreshToken !== previous.refreshToken ||
                generation !== this.sessionGeneration
                  ? Effect.void
                  : this.secrets.delete(this.policy.secretKey),
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
