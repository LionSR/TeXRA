/**
 * The subscription coordinator's public contract: the session it stores,
 * the token grant and authorize request its sign-in flows pass it, and the
 * {@link SubscriptionCoordinator} a caller holds. The implementation is
 * `SubscriptionOAuthCoordinator.ts`.
 */
import type { SecretsFailed } from '../providers/credentials.js';
import type { SubscriptionOAuthError } from './subscriptionOAuthError.js';
import type { SubscriptionSessionBaseSchema } from './subscriptionSessionSchema.js';
import type { Effect } from 'effect';
import type { HttpClient } from 'effect/http';
import type { z } from 'zod';

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
export type SubscriptionSession = z.infer<
  typeof SubscriptionSessionBaseSchema
> & {
  email?: string;
  accountId?: string;
};

/** The authorize URL a loopback login opens, and what its callback checks. */
export interface SubscriptionAuthorizeRequest {
  url: string;
  /** The high-entropy secret carried through the loopback round-trip. */
  verifier: string;
  state: string;
  redirectUri: string;
}

/** Whether a session is stored, and the account it names. */
export interface SubscriptionSessionStatus {
  signedIn: boolean;
  email?: string;
  accountId?: string;
}

/**
 * One provider's subscription session over the caller's secret store:
 * reading it, keeping it fresh, signing in and out. The mutating and
 * refreshing programs fail with {@link SubscriptionOAuthError}, or with the
 * secret store's own {@link SecretsFailed} when it rejects.
 */
export interface SubscriptionCoordinator<S extends SubscriptionSession> {
  /** The stored session, or null when none is stored; a stored one that
   *  does not parse fails `fatal`. */
  loadSession(): Effect.Effect<
    S | null,
    SecretsFailed | SubscriptionOAuthError
  >;
  /** Signed-in status of the stored session. */
  getStatus(): Effect.Effect<
    SubscriptionSessionStatus,
    SecretsFailed | SubscriptionOAuthError
  >;
  /** The stored session, refreshed when it expires soon. */
  getFreshSession(): Effect.Effect<S, Error, HttpClient.HttpClient>;
  /** Refresh now, while the stored session still holds `accessToken`: the
   *  provider rejected it before its expiry. */
  refreshRejected(
    accessToken: string,
  ): Effect.Effect<void, Error, HttpClient.HttpClient>;
  /** Forget the stored session. */
  signOut(): Effect.Effect<void, SecretsFailed>;
  /** The PKCE authorize URL for a loopback callback on `port`. */
  buildAuthorizeRequest(port: number): SubscriptionAuthorizeRequest;
  /** Exchange an authorization code and store the session it grants. */
  loginWithCode(params: {
    code: string;
    verifier: string;
    redirectUri: string;
  }): Effect.Effect<S, Error, HttpClient.HttpClient>;
  /** Store the session a completed token grant returned. */
  storeTokens(tokens: SubscriptionTokenResponse): Effect.Effect<S, Error>;
}
