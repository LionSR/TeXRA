/**
 * The subscription coordinator's contract: the session it stores, the
 * {@link SubscriptionCoordinator} a caller holds, and the
 * {@link SubscriptionOAuthPolicy} a provider writes, with the token grant and
 * authorize request its sign-in steps pass between them. The implementation
 * is `SubscriptionOAuthCoordinator.ts`.
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
import type { SubscriptionDeviceCodePrompt } from './deviceAuthorization.js';
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
    email?: string | undefined;
    accountId?: string | undefined;
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
 * reading it, keeping it fresh, signing in and out. The account runs the
 * provider's sign-in protocol itself; the caller supplies only the
 * presentation. The mutating and refreshing programs fail with
 * {@link SubscriptionOAuthError}, or with the secret store's own
 * {@link SecretsFailed} when it rejects.
 */
export interface SubscriptionCoordinator<S extends SubscriptionSession> {
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
  /**
   * Sign in through a browser: bind the provider's loopback callback, show
   * the consent URL with `openBrowser`, and store the session the callback's
   * code grants. A callback that cannot be bound, or a browser that cannot
   * be reached, fails with `LoopbackTransportUnavailableError` before
   * anything is asked of the user.
   */
  readonly signInWithBrowser: (
    openBrowser: (url: string) => Effect.Effect<void, Error>,
  ) => Effect.Effect<S, Error, HttpClient.HttpClient>;
  /**
   * Sign in with a one-time device code (RFC 8628): `onPrompt` shows the
   * code, and the session is stored once the user approves. Absent where
   * the provider has no device-code sign-in.
   */
  readonly signInWithDeviceCode?: (
    onPrompt: (prompt: SubscriptionDeviceCodePrompt) => Effect.Effect<void>,
  ) => Effect.Effect<S, Error, HttpClient.HttpClient>;
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
  /** The registered loopback callback a browser sign-in binds. */
  readonly loopback: {
    /** Callback ports, tried in order; 0 takes any free port. */
    readonly ports: readonly number[];
    /** Path of the registered redirect URI (e.g. `/auth/callback`). */
    readonly callbackPath: string;
    /** The provider's name in the callback page and errors (e.g. `Grok`). */
    readonly displayName: string;
  };
  /**
   * The provider's device-code grant: show the code with `onPrompt`, poll
   * until the user approves, and answer the tokens. Absent: no device-code
   * sign-in.
   */
  readonly deviceGrant?: (
    onPrompt: (prompt: SubscriptionDeviceCodePrompt) => Effect.Effect<void>,
  ) => Effect.Effect<SubscriptionTokenResponse, Error, HttpClient.HttpClient>;
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
