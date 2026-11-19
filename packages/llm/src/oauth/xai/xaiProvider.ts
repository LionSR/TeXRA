/**
 * The experimental "Sign in with Grok" (xAI SuperGrok) provider: its
 * constants, token and session schemas, JWT claims, the RFC 8628 device-code
 * grant, and the OAuth policy its account (`SubscriptionAccounts`'s) runs.
 *
 * Rides a public Grok-CLI OAuth client registration. xAI can change or revoke
 * that registration without notice — never present this as an xAI-sanctioned
 * integration. Keep every sign-in magic value here so an upstream change
 * is a one-file edit; the API endpoint the subscription bills is xAI's own
 * (`XAI_DEFAULT_ENDPOINT`), which the route decision names.
 *
 * Sources (read from source, not blog posts):
 * - OpenCode: packages/opencode/src/plugin/xai.ts (anomalyco/opencode)
 * - hermes-agent pull request 26534 (Grok-CLI client id registration notes in OpenCode)
 */

import { Effect, Option, Schema, SchemaGetter, Struct } from 'effect';
import {
  DeviceAuthorizationPending,
  DeviceAuthorizationTransient,
  pollDeviceAuthorization,
  type SubscriptionDeviceCodePrompt,
} from '../deviceAuthorization.js';
import { NonEmptyJwtClaim, decodeJwtClaimsWithSchema } from '../jwtDecode.js';
import {
  OAuthHttpError,
  oauthHttpError,
  oauthTokenErrorKind,
  parseOAuthJson,
  postOAuthForm,
} from '../oauthRequest.js';
import {
  SubscriptionSessionBaseSchema,
  SubscriptionTokenResponseSchema,
} from '../subscriptionSessionSchema.js';
import { SubscriptionOAuthError } from '../subscriptionOAuthError.js';
import type { SubscriptionOAuthPolicy } from '../subscriptionCoordinator.js';
import type { ClientIdentity } from '../../node.js';

/** Borrowed OAuth client id (Grok CLI desktop registration). */
const XAI_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';

/** xAI auth issuer base. */
const XAI_ISSUER = 'https://auth.x.ai';

/** OAuth authorize endpoint. */
const XAI_AUTHORIZE_URL = `${XAI_ISSUER}/oauth2/authorize`;

/** OAuth token endpoint (code exchange + refresh + device poll). */
const XAI_TOKEN_URL = `${XAI_ISSUER}/oauth2/token`;

/** RFC 8628 device authorization endpoint. */
const XAI_DEVICE_AUTHORIZATION_URL = `${XAI_ISSUER}/oauth2/device/code`;

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
const XAI_SCOPE =
  'openid profile email offline_access grok-cli:access api:access';

/**
 * `plan=generic` opts the consent screen into xAI's generic OAuth plan tier;
 * without it, accounts.x.ai rejects loopback OAuth from non-allowlisted clients.
 */
const XAI_PLAN = 'generic';

/** RFC 8628 device-code grant type. */
const XAI_DEVICE_CODE_GRANT_TYPE =
  'urn:ietf:params:oauth:grant-type:device_code';

/**
 * Secret-storage key for the persisted OAuth token bundle. Outside the
 * `apiKey.<provider>` namespace so it never collides with API-key scans.
 */
const XAI_SESSION_SECRET_KEY = 'auth.xai-grok';

/** Fallback access-token lifetime when the token response omits expires_in. */
const XAI_DEFAULT_EXPIRES_IN_SEC = 3600;

/** Default device-code poll interval when the endpoint omits `interval`. */
const XAI_DEVICE_DEFAULT_INTERVAL_SEC = 5;

/** Default device-code lifetime when the endpoint omits `expires_in`. */
const XAI_DEVICE_DEFAULT_EXPIRES_SEC = 5 * 60;

/** RFC 8628 slow_down increment (seconds). */
const XAI_DEVICE_SLOW_DOWN_INCREMENT_SEC = 5;

/** Raw response from the OAuth token endpoint (code exchange + refresh). */
const XaiTokenResponseSchema = SubscriptionTokenResponseSchema.mapFields(
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
        Schema.withDecodingDefault(Effect.succeed(XAI_DEFAULT_EXPIRES_IN_SEC)),
      ),
    token_type: Schema.optional(Schema.NullOr(Schema.String)),
    scope: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);

/** The persisted OAuth session bundle. */
const XaiSessionSchema = SubscriptionSessionBaseSchema.mapFields(
  Struct.assign({
    email: Schema.optional(Schema.NonEmptyString),
  }),
);
/** A stored xAI (Grok) session. */
export type XaiSession = typeof XaiSessionSchema.Type;

/** RFC 8628 device-code authorization response. */
const XaiDeviceCodeSchema = Schema.Struct({
  device_code: Schema.NonEmptyString,
  user_code: Schema.NonEmptyString,
  verification_uri: Schema.NonEmptyString,
  verification_uri_complete: Schema.optional(
    Schema.NullOr(Schema.NonEmptyString),
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

/** Begin the RFC 8628 device-code flow. */
const requestDeviceCode = Effect.fn('xai.requestDeviceCode')(function* () {
  const response = yield* postOAuthForm(
    XAI_DEVICE_AUTHORIZATION_URL,
    new URLSearchParams({
      client_id: XAI_CLIENT_ID,
      scope: XAI_SCOPE,
    }),
  );
  if (!response.ok) {
    return yield* oauthHttpError(response, 'Device code request');
  }
  return yield* parseOAuthJson(
    response,
    XaiDeviceCodeSchema,
    'Device code request returned an unexpected response',
  );
});

/** An RFC 6749 error body; a field of another shape reads as absent. */
const DeviceErrorBodySchema = Schema.Struct({
  error: Schema.optional(Schema.String).pipe(
    Schema.catchDecoding(() => Effect.succeed(Option.some(undefined))),
  ),
  error_description: Schema.optional(Schema.String).pipe(
    Schema.catchDecoding(() => Effect.succeed(Option.some(undefined))),
  ),
});

/**
 * Poll once for the device authorization result. Succeeds with tokens, or
 * fails with {@link DeviceAuthorizationPending} while the user has not yet
 * approved. A network blip mid-poll is {@link DeviceAuthorizationTransient},
 * which the shared poll retries a few times before failing with it.
 * A refused authorization or an expired code is a
 * {@link SubscriptionOAuthError} that needs a fresh sign-in.
 */
const pollDeviceToken = Effect.fn('xai.pollDeviceToken')(function* (
  deviceCode: string,
) {
  const response = yield* postOAuthForm(
    XAI_TOKEN_URL,
    new URLSearchParams({
      grant_type: XAI_DEVICE_CODE_GRANT_TYPE,
      client_id: XAI_CLIENT_ID,
      device_code: deviceCode,
    }),
  ).pipe(
    Effect.catchTag('OAuthNetworkError', (error) =>
      Effect.fail(new DeviceAuthorizationTransient({ error })),
    ),
  );

  if (response.ok) {
    return yield* parseOAuthJson(
      response,
      XaiTokenResponseSchema,
      'Device authorization returned an unexpected token response',
    );
  }

  // Best effort: a body that is not an error object carries no code.
  const { error: oauthError, error_description: errorDescription } =
    yield* parseOAuthJson(response, DeviceErrorBodySchema, '').pipe(
      Effect.orElseSucceed(() => ({
        error: undefined,
        error_description: undefined,
      })),
    );
  if (oauthError === 'authorization_pending' || oauthError === 'slow_down') {
    return yield* new DeviceAuthorizationPending({
      slowDown: oauthError === 'slow_down',
    });
  }
  if (oauthError === 'access_denied' || oauthError === 'authorization_denied') {
    return yield* new SubscriptionOAuthError({
      message: 'Grok device authorization was denied',
      kind: 'fatal',
      status: response.status,
    });
  }
  if (oauthError === 'expired_token') {
    return yield* new SubscriptionOAuthError({
      message: 'Grok device code expired — please sign in again',
      kind: 'expired',
      status: response.status,
    });
  }
  const detail = errorDescription ?? oauthError ?? '';
  return yield* new OAuthHttpError({
    message: `Device token exchange failed (HTTP ${response.status})${
      detail ? `: ${detail}` : ''
    }`,
    status: response.status,
    kind: oauthTokenErrorKind(response.status),
  });
});

/**
 * The RFC 8628 device-code grant, for headless, SSH and non-TTY hosts: the
 * user opens a URL and types a one-time code while this polls the token
 * endpoint until they approve. The requests, the spaced poll with
 * `slow_down` growth and the code's expiry run on one fiber, so the host's
 * interruption reaches the requests and the wait. Fails with a tagged error
 * whose `message` is the user-facing text.
 */
const xaiDeviceGrant = Effect.fn('xai.deviceGrant')(function* (
  onPrompt: (prompt: SubscriptionDeviceCodePrompt) => Effect.Effect<void>,
) {
  const device = yield* requestDeviceCode();
  // Floor to 1s so a misbehaving endpoint cannot busy-loop us.
  const intervalMs = Math.max(
    (device.interval ?? XAI_DEVICE_DEFAULT_INTERVAL_SEC) * 1000,
    1000,
  );
  yield* onPrompt({
    userCode: device.user_code,
    verificationUrl: device.verification_uri,
    verificationUrlComplete: device.verification_uri_complete ?? undefined,
  });
  return yield* pollDeviceAuthorization({
    poll: pollDeviceToken(device.device_code),
    intervalMs,
    expiresInMs: (device.expires_in ?? XAI_DEVICE_DEFAULT_EXPIRES_SEC) * 1000,
    slowDownIncrementMs: XAI_DEVICE_SLOW_DOWN_INCREMENT_SEC * 1000,
  });
});

/**
 * The Grok sign-in policy for the shared `SubscriptionOAuthCoordinator`: only
 * the authorize URL, claims, and JWT-exp refresh differ from ChatGPT,
 * so the shared coordinator runs it as is. The authorize URL's attribution
 * referrer is `client.id`, the app's own: never another client's
 * (`opencode`, `grok-cli`).
 */
export const xaiPolicy = (
  client: ClientIdentity,
): SubscriptionOAuthPolicy<XaiSession> =>
  Object.freeze<SubscriptionOAuthPolicy<XaiSession>>({
    secretKey: XAI_SESSION_SECRET_KEY,
    sessionSchema: XaiSessionSchema,
    tokenEndpoint: Object.freeze({
      tokenUrl: XAI_TOKEN_URL,
      clientId: XAI_CLIENT_ID,
      tokenResponseSchema: XaiTokenResponseSchema,
    }),
    notSignedInMessage: 'Not signed in with Grok. Run sign-in first.',
    loopback: Object.freeze({
      ports: [XAI_CALLBACK_PORT],
      callbackPath: XAI_CALLBACK_PATH,
      displayName: 'Grok',
    }),
    deviceGrant: xaiDeviceGrant,
    // xAI pins one redirect port, so the bind's port is ignored.
    authorize: Object.freeze({
      url: XAI_AUTHORIZE_URL,
      scope: XAI_SCOPE,
      redirectUri: xaiRedirectUri,
      params: Object.freeze({ plan: XAI_PLAN, referrer: client.id }),
    }),
    buildSession(tokens, refreshToken, nowMs, previous) {
      // Refresh keys off the *access* token. Prefer access JWT exp over
      // id_token.exp (which can outlive the access token). Each token is
      // decoded exactly once here and the email claim reuses that decode.
      // `expires_in` is already normalized to a positive number by
      // XaiTokenResponseSchema, so no second default is applied here.
      const idClaims = tokens.id_token
        ? decodeXaiJwtClaims(tokens.id_token)
        : {};
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
  });
