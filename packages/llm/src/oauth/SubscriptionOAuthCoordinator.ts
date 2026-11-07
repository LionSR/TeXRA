/**
 * Host-neutral coordinator for a subscription OAuth session (ChatGPT, Grok, …).
 *
 * Pure state machine over injected secret storage. Provider
 * differences (authorize URL, claim extraction) live in the
 * {@link SubscriptionOAuthPolicy}; this class owns one lock around every
 * read-then-write of the stored session: a refresh, a sign-in's store and a
 * sign-out's delete take turns, so concurrent callers that find a session
 * expiring share the refresh the first of them made, and a sign-in or a
 * sign-out waits for an exchange in flight instead of racing it.
 *
 * Every method is an Effect program the caller yields or runs at its own
 * edge. A program fails with {@link SubscriptionOAuthError} or with the
 * secret store's own {@link SecretsFailed}.
 */
// Third-party imports
import { Clock, Effect, Exit, Result, Schema, Semaphore } from 'effect';

// Local imports
import { toErrorMessage } from './support.js';

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
   * may rotate on use, so callers sharing a store must share one lock.
   * Replacing the store starts an independent one.
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
  /** Held across every read-then-write of the stored session. */
  private readonly lock = Semaphore.makeUnsafe(1);

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
      registration && (yield* registration(this.secrets)),
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

  /** End the stored (readable) session at the provider, then delete it either
   *  way; a failed end is reported after. Under the lock, after any refresh in
   *  flight, so the token ended is the one a refresh rotated to, not the one
   *  it replaced. */
  readonly signOut = Effect.fn('SubscriptionOAuthCoordinator.signOut')(
    function* (this: SubscriptionOAuthCoordinator<S>) {
      const { endSession } = this.policy;
      const ended = yield* this.lock.withPermit(
        Effect.gen({ self: this }, function* () {
          const ended = yield* Effect.exit(
            this.loadSession().pipe(
              Effect.catchTag('SubscriptionOAuthError', () =>
                Effect.succeed(null),
              ),
              Effect.flatMap((session) =>
                session && endSession ? endSession(session) : Effect.void,
              ),
            ),
          );
          yield* Effect.uninterruptible(
            this.secrets.delete(this.policy.secretKey),
          );
          return ended;
        }),
      );
      if (Exit.isFailure(ended)) return yield* Effect.failCause(ended.cause);
    },
  );

  /**
   * Persist tokens from a successful device-code (or other) grant: the
   * session built from them becomes the stored one, after any refresh in
   * flight.
   */
  readonly storeTokens = Effect.fn('SubscriptionOAuthCoordinator.storeTokens')(
    function* (
      this: SubscriptionOAuthCoordinator<S>,
      tokens: SubscriptionTokenResponse,
      clientId?: string,
    ) {
      const session = yield* this.buildSession(tokens, undefined, clientId);
      yield* this.lock.withPermit(Effect.uninterruptible(this.store(session)));
      return session;
    },
  );

  /**
   * The code exchange, yielded by the loopback login so its interruption
   * reaches the exchange and the store. A registering attempt takes the
   * client the callback names; a returning one rejects any other.
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
      yield* this.policy.acceptGrant(
        tokens,
        { ...request, clientId },
        this.secrets,
      );
    return yield* this.storeTokens(tokens, clientId);
  });

  /**
   * The stored session, refreshed when expiring soon or when it still holds
   * `rejected`. Under the lock, so a caller that waited for another's refresh
   * finds the refreshed session and refreshes nothing. The exchange and the
   * store are one uninterruptible step: a provider that rotates a single-use
   * refresh token on the exchange must see the new one stored, whoever stops
   * waiting; the token request carries its own deadline.
   */
  private readonly freshSession = Effect.fn(
    'SubscriptionOAuthCoordinator.getFreshSession',
  )(function* (this: SubscriptionOAuthCoordinator<S>, rejected?: string) {
    return yield* this.lock.withPermit(
      Effect.gen({ self: this }, function* () {
        const session = yield* this.loadSession();
        if (!session) {
          return yield* new SubscriptionOAuthError({
            message: this.policy.notSignedInMessage,
            kind: 'expired',
          });
        }
        if (
          session.accessToken !== rejected &&
          !this.isExpiringSoon(session, yield* Clock.currentTimeMillis)
        )
          return session;
        return yield* Effect.uninterruptible(this.refresh(session));
      }),
    );
  });

  /** Exchange `previous`'s refresh token and store the session it buys; a
   *  fatal refusal deletes the stored one, which the lock holds unchanged. */
  private readonly refresh = Effect.fn('SubscriptionOAuthCoordinator.refresh')(
    function* (this: SubscriptionOAuthCoordinator<S>, previous: S) {
      const tokens = yield* refreshOAuthTokens(
        this.policy.tokenEndpoint,
        previous.refreshToken,
        previous.clientId ?? this.policy.tokenEndpoint.clientId,
      ).pipe(
        Effect.mapError(grantFailure),
        Effect.tapError((error) =>
          error.kind === 'fatal'
            ? this.secrets.delete(this.policy.secretKey)
            : Effect.void,
        ),
      );
      const session = yield* this.buildSession(tokens, previous);
      yield* this.store(session);
      return session;
    },
  );
}
