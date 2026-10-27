/**
 * The experimental "Sign in with Grok" (xAI SuperGrok) provider: its
 * constants, token and session schemas, JWT claims, OAuth policy, and the
 * coordinator and loopback sign-in bound to them. The RFC 8628 device
 * protocol lives in `xaiOAuthClient.ts` and `xaiDeviceLogin.ts`.
 *
 * Rides a public Grok-CLI OAuth client registration. xAI can change or revoke
 * that registration without notice — never present this as an xAI-sanctioned
 * TeXRA integration. Keep every sign-in magic value here so an upstream change
 * is a one-file edit; the API endpoint the subscription bills is the xAI
 * provider plugin's, which `resolveRouteEndpoint` reads.
 *
 * Sources (read from source, not blog posts):
 * - OpenCode: packages/opencode/src/plugin/xai.ts (anomalyco/opencode)
 * - hermes-agent pull request 26534 (Grok-CLI client id registration notes in OpenCode)
 */

import { Effect, Option, Schema, SchemaGetter, Struct } from 'effect';
import { NonEmptyJwtClaim, decodeJwtClaimsWithSchema } from '../jwtDecode.js';
import { defineLoopbackLogin } from '../loopbackLogin.js';
import { createSecretBackedCoordinator } from '../sessionAccess.js';
import { SubscriptionOAuthCoordinator } from '../SubscriptionOAuthCoordinator.js';
import {
  SubscriptionSessionBaseSchema,
  SubscriptionTokenResponseSchema,
} from '../subscriptionSessionSchema.js';
import type {
  CredentialStore,
  SecretsFailed,
} from '../../providers/credentials.js';
import type { SubscriptionOAuthError } from '../subscriptionOAuthError.js';
import type {
  SubscriptionCoordinator,
  SubscriptionSessionStatus,
} from '../subscriptionCoordinator.js';
import type { SubscriptionOAuthPolicy } from '../SubscriptionOAuthCoordinator.js';

/** Borrowed OAuth client id (Grok CLI desktop registration). */
export const XAI_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';

/** xAI auth issuer base. */
const XAI_ISSUER = 'https://auth.x.ai';

/** OAuth authorize endpoint. */
const XAI_AUTHORIZE_URL = `${XAI_ISSUER}/oauth2/authorize`;

/** OAuth token endpoint (code exchange + refresh + device poll). */
export const XAI_TOKEN_URL = `${XAI_ISSUER}/oauth2/token`;

/** RFC 8628 device authorization endpoint. */
export const XAI_DEVICE_AUTHORIZATION_URL = `${XAI_ISSUER}/oauth2/device/code`;

/**
 * Loopback redirect — the Grok-CLI client registration pins host:port:path.
 * Do NOT pick another port; xAI rejects non-registered redirect_uris.
 */
const XAI_CALLBACK_HOST = '127.0.0.1';
const XAI_CALLBACK_PORT = 56121;
const XAI_CALLBACK_PATH = '/callback';

/** Build the loopback redirect URI (only one port is registered). */
function xaiRedirectUri(): string {
  return `http://${XAI_CALLBACK_HOST}:${XAI_CALLBACK_PORT}${XAI_CALLBACK_PATH}`;
}

/** OAuth scopes requested at authorize / device time. */
export const XAI_SCOPE =
  'openid profile email offline_access grok-cli:access api:access';

/**
 * Attribution referrer on the authorize URL. Our own string — do not
 * impersonate `opencode` or `grok-cli`.
 */
const XAI_REFERRER = 'texra';

/**
 * `plan=generic` opts the consent screen into xAI's generic OAuth plan tier;
 * without it, accounts.x.ai rejects loopback OAuth from non-allowlisted clients.
 */
const XAI_PLAN = 'generic';

/** RFC 8628 device-code grant type. */
export const XAI_DEVICE_CODE_GRANT_TYPE =
  'urn:ietf:params:oauth:grant-type:device_code';

/**
 * Secret-storage key for the persisted OAuth token bundle. Outside the
 * `apiKey.<provider>` namespace so it never collides with API-key scans.
 */
const XAI_SESSION_SECRET_KEY = 'auth.xai-grok';

/** Fallback access-token lifetime when the token response omits expires_in. */
const XAI_DEFAULT_EXPIRES_IN_SEC = 3600;

/** Default device-code poll interval when the endpoint omits `interval`. */
export const XAI_DEVICE_DEFAULT_INTERVAL_SEC = 5;

/** Default device-code lifetime when the endpoint omits `expires_in`. */
export const XAI_DEVICE_DEFAULT_EXPIRES_SEC = 5 * 60;

/** RFC 8628 slow_down increment (seconds). */
export const XAI_DEVICE_SLOW_DOWN_INCREMENT_SEC = 5;

/** Raw response from the OAuth token endpoint (code exchange + refresh). */
export const XaiTokenResponseSchema = SubscriptionTokenResponseSchema.mapFields(
  Struct.assign({
    // Provider-boundary guard: absent or non-positive expires_in is not a
    // security decision — fall back to a short default and let JWT exp / 401
    // drive the real refresh. Prefer access JWT exp in buildSession when present.
    expires_in: Schema.Union([Schema.Finite, Schema.FiniteFromString])
      .check(Schema.isGreaterThan(0))
      .pipe(
        Schema.catchDecoding(() =>
          Effect.succeed(Option.some(XAI_DEFAULT_EXPIRES_IN_SEC)),
        ),
      )
      .pipe(
        Schema.withDecodingDefault(Effect.succeed(XAI_DEFAULT_EXPIRES_IN_SEC)),
      ),
    token_type: Schema.optional(Schema.NullOr(Schema.String)),
    scope: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);

/** The persisted OAuth session bundle. */
const XaiSessionSchema = SubscriptionSessionBaseSchema.mapFields(
  Struct.assign({
    email: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  }),
);
/** A stored xAI (Grok) session. */
export type XaiSession = typeof XaiSessionSchema.Type;

/** RFC 8628 device-code authorization response. */
export const XaiDeviceCodeSchema = Schema.Struct({
  device_code: Schema.String.check(Schema.isMinLength(1)),
  user_code: Schema.String.check(Schema.isMinLength(1)),
  verification_uri: Schema.String.check(Schema.isMinLength(1)),
  verification_uri_complete: Schema.optional(
    Schema.NullOr(Schema.String.check(Schema.isMinLength(1))),
  ),
  expires_in: Schema.optional(
    Schema.NullOr(
      Schema.Union([Schema.Finite, Schema.FiniteFromString]).check(
        Schema.isGreaterThan(0),
      ),
    ),
  ).pipe(Schema.catchDecoding(() => Effect.succeed(Option.some(undefined)))),
  interval: Schema.optional(
    Schema.NullOr(
      Schema.Union([Schema.Finite, Schema.FiniteFromString]).check(
        Schema.isGreaterThan(0),
      ),
    ),
  ).pipe(Schema.catchDecoding(() => Effect.succeed(Option.some(undefined)))),
});

// JWT claim extraction. We never verify the signature (the token came from the
// OAuth token endpoint over TLS). Claims are only used for display (email) and
// proactive refresh (`exp`) — never as an authorization decision on their own.

/** Account identity distilled from a JWT (any field may be absent). */
const XaiJwtClaimsSchema = Schema.Struct({
  email: Schema.optional(Schema.String),
  /** Absolute expiry (ms since epoch) when the JWT carries `exp`. */
  expiresAtMs: Schema.optional(Schema.Number),
});
type XaiJwtClaims = typeof XaiJwtClaimsSchema.Type;

/** Validates an UNTRUSTED decoded JWT payload and distills the claims we read. */
const XaiJwtPayloadSchema = Schema.Struct({
  email: NonEmptyJwtClaim,
  preferred_username: NonEmptyJwtClaim,
  exp: Schema.optional(Schema.Finite).pipe(
    Schema.catchDecoding(() => Effect.succeed(Option.some(undefined))),
  ),
}).pipe(
  Schema.decodeTo(XaiJwtClaimsSchema, {
    decode: SchemaGetter.transform((claims) => ({
      email: claims.email ?? claims.preferred_username,
      expiresAtMs:
        claims.exp == null ? undefined : Math.trunc(claims.exp) * 1000,
    })),
    encode: SchemaGetter.forbidden(() => 'decode-only'),
  }),
);

const EMPTY_CLAIMS: XaiJwtClaims = {};

/**
 * Decode + validate a JWT's claims (middle base64url segment). Returns empty
 * claims on any structural error; never throws.
 */
function decodeXaiJwtClaims(token: string): XaiJwtClaims {
  return decodeJwtClaimsWithSchema(token, XaiJwtPayloadSchema, EMPTY_CLAIMS);
}

/**
 * The Grok sign-in policy for the shared `SubscriptionOAuthCoordinator`: only
 * the authorize URL, claims, and JWT-exp refresh differ from ChatGPT/Codex,
 * so the shared coordinator runs it as is.
 */
const XAI_POLICY: SubscriptionOAuthPolicy<XaiSession> = {
  sessionSchema: XaiSessionSchema,
  tokenEndpoint: {
    tokenUrl: XAI_TOKEN_URL,
    clientId: XAI_CLIENT_ID,
    tokenResponseSchema: XaiTokenResponseSchema,
  },
  notSignedInMessage: 'Not signed in with Grok. Run sign-in first.',
  sessionChangedMessage: 'Grok session changed while refreshing. Try again.',
  // xAI pins one redirect port, so the bind's port is ignored.
  authorize: {
    url: XAI_AUTHORIZE_URL,
    scope: XAI_SCOPE,
    redirectUri: xaiRedirectUri,
    params: { plan: XAI_PLAN, referrer: XAI_REFERRER },
  },
  buildSession(tokens, refreshToken, nowMs, previous) {
    // Refresh keys off the *access* token. Prefer access JWT exp over
    // id_token.exp (which can outlive the access token). Each token is
    // decoded exactly once here and the email claim reuses that decode.
    // `expires_in` is already normalized to a positive number by
    // XaiTokenResponseSchema, so no second default is applied here.
    const idClaims = tokens.id_token ? decodeXaiJwtClaims(tokens.id_token) : {};
    const accessClaims = decodeXaiJwtClaims(tokens.access_token);
    const expiresAtMs =
      accessClaims.expiresAtMs ?? nowMs + tokens.expires_in * 1000;
    return {
      accessToken: tokens.access_token,
      refreshToken,
      idToken: tokens.id_token ?? previous?.idToken,
      expiresAtMs,
      email: idClaims.email ?? accessClaims.email ?? previous?.email,
    };
  },
};

/**
 * The coordinator for the caller's secret store: one coordinator per store
 * instance, so distinct stores never share session state.
 */
export const xaiCoordinator: (
  secrets: CredentialStore,
) => SubscriptionCoordinator<XaiSession> = createSecretBackedCoordinator({
  secretKey: XAI_SESSION_SECRET_KEY,
  makeCoordinator: (storage) =>
    new SubscriptionOAuthCoordinator({ storage, policy: XAI_POLICY }),
});

/** Signed-in status, read from the caller's secret store. A store that
 *  cannot be read, or a stored session that does not parse, fails. */
export function getXaiStatus(
  secrets: CredentialStore,
): Effect.Effect<
  SubscriptionSessionStatus,
  SecretsFailed | SubscriptionOAuthError
> {
  return Effect.suspend(() => xaiCoordinator(secrets).getStatus());
}

/** The browser sign-in, bound to the registered Grok callback. */
export const xaiLoginWithLoopback = defineLoopbackLogin<XaiSession>({
  ports: [XAI_CALLBACK_PORT],
  callbackPath: XAI_CALLBACK_PATH,
  displayName: 'Grok',
});
