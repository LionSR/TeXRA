/**
 * The subscription coordinator's public contract: the session it stores,
 * the token grant and authorize request its sign-in flows pass it, the
 * {@link SubscriptionCoordinator} a caller holds, and the
 * {@link SubscriptionOAuthPolicy} a provider writes. The implementation is
 * `SubscriptionOAuthCoordinator.ts`.
 */
import type {
  CredentialStore,
  SecretsFailed,
} from '../providers/credentials.js';
import type { SubscriptionOAuthError } from './subscriptionOAuthError.js';
import type {
  SubscriptionSessionBaseSchema,
  SubscriptionTokenResponseSchema,
} from './subscriptionSessionSchema.js';
import type { OAuthFormEndpoint } from './formTokenClient.js';
import type { Effect, Schema } from 'effect';
import type { HttpClient } from 'effect/http';

/** Raw token-endpoint shape shared by authorization-code and refresh grants. */
export type SubscriptionTokenResponse =
  (typeof SubscriptionTokenResponseSchema)['Type'];

/** Canonical stored session: the persisted base schema's shape (its single
 *  source of truth) plus the two optional identity fields the status read
 *  reports. Providers may add fields via intersection types. */
export type SubscriptionSession =
  (typeof SubscriptionSessionBaseSchema)['Type'] & {
    email?: string;
    accountId?: string;
  };

/** The authorize URL a loopback login opens, and what its callback checks. */
export interface SubscriptionAuthorizeRequest {
  url: string;
  /** The high-entropy secret carried through the loopback round-trip. */
  verifier: string;
  state: string;
  /** The OIDC nonce the returned ID token must carry. */
  nonce: string;
  redirectUri: string;
  /** The client this attempt authorizes as. */
  clientId: string;
  /**
   * The attempt registers a new client for the user: the callback names the
   * client the provider issued, and the grant and the session use that one.
   */
  registering: boolean;
}

/** What a loopback callback delivered: the code, and any client it named. */
export interface SubscriptionCallback {
  readonly code: string;
  readonly clientId: string | undefined;
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
  /** End the stored session at the provider, then forget it either way; a
   *  provider that could not confirm the end fails after the local sign-out. */
  signOut(): Effect.Effect<
    void,
    SecretsFailed | SubscriptionOAuthError,
    HttpClient.HttpClient
  >;
  /** The PKCE authorize URL for a loopback callback on `port`. */
  buildAuthorizeRequest(
    port: number,
  ): Effect.Effect<
    SubscriptionAuthorizeRequest,
    SecretsFailed | SubscriptionOAuthError
  >;
  /** Exchange the code `request`'s callback delivered and store the
   *  session it grants. */
  loginWithCode(
    request: SubscriptionAuthorizeRequest,
    callback: SubscriptionCallback,
  ): Effect.Effect<S, Error, HttpClient.HttpClient>;
  /** Store the session a completed token grant returned. */
  storeTokens(tokens: SubscriptionTokenResponse): Effect.Effect<S, Error>;
}

/** Provider-specific policy: every magic URL/claim out of the machine. */
export interface SubscriptionOAuthPolicy<S extends SubscriptionSession> {
  /** The credential-store key that holds this provider's session. */
  readonly secretKey: string;
  /** The persisted session bundle's schema. */
  readonly sessionSchema: Schema.Codec<S, unknown>;
  /** Form token endpoint the token grants go to. */
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
  /**
   * A provider that registers a client per user and keeps that registration
   * beside the session, so it outlives sign-out: the client this attempt
   * authorizes as, and the parameters a registration needs. Absent: every
   * attempt authorizes as `tokenEndpoint.clientId`.
   */
  readonly registration?: (secrets: CredentialStore) => Effect.Effect<
    {
      readonly clientId: string;
      readonly registering: boolean;
      readonly params: Readonly<Record<string, string>>;
    },
    SecretsFailed | SubscriptionOAuthError
  >;
  /**
   * Check a code grant before its session is stored, and record what the
   * registration keeps. `attempt` names the client the grant was issued to.
   * Absent: no check, and no nonce is sent.
   */
  readonly acceptGrant?: (
    tokens: SubscriptionTokenResponse,
    attempt: SubscriptionAuthorizeRequest,
    secrets: CredentialStore,
  ) => Effect.Effect<
    void,
    SubscriptionOAuthError | SecretsFailed,
    HttpClient.HttpClient
  >;
  /**
   * End a session at the provider before sign-out deletes it (token
   * revocation). Absent: sign-out only deletes it.
   */
  readonly endSession?: (
    session: S,
  ) => Effect.Effect<void, SubscriptionOAuthError, HttpClient.HttpClient>;
  /** Token response to session. Must not throw: it runs in `Effect.succeed`. */
  buildSession(
    tokens: SubscriptionTokenResponse,
    refreshToken: string,
    nowMs: number,
    previous?: S,
  ): S;
}
