/**
 * The experimental "Sign in with ChatGPT" (Codex subscription) provider: its
 * constants, token and session schemas, JWT claims, OAuth policy, and the
 * coordinator and loopback sign-in bound to them. The device-code protocol
 * lives in `codexOAuthClient.ts` and `codexDeviceLogin.ts`.
 *
 * This rides an UNOFFICIAL OpenAI endpoint and a borrowed OAuth client id (the
 * Codex CLI's). It can break or be revoked without notice and must never be
 * presented as an OpenAI-sanctioned integration. Keep every sign-in magic value
 * here so an upstream OpenAI change is a one-file edit; the backend URL the
 * subscription bills is `resolveRouteEndpoint`'s (`../../models/routeEndpoint.ts`).
 *
 * Sources (read directly from source, not blog posts):
 * - OpenCode native plugin: opencode/src/plugin/openai/codex.ts
 * - OpenCode auth plugin: numman-ali/opencode-openai-codex-auth lib/auth/auth.ts
 * - Device flow: tumf/opencode-openai-device-auth src/index.ts
 * - Zed: crates/language_models/src/provider/openai_subscribed.rs
 */

import { Effect, Option, Schema, SchemaGetter, Struct } from 'effect';
import { NonEmptyJwtClaim, decodeJwtClaimsWithSchema } from '../jwtDecode.js';
import { defineLoopbackLogin } from '../loopbackLogin.js';
import { createSecretBackedCoordinator } from '../sessionAccess.js';
import { SubscriptionOAuthCoordinator } from '../SubscriptionOAuthCoordinator.js';
import { SubscriptionSessionBaseSchema } from '../subscriptionSessionSchema.js';
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

/** Borrowed OAuth client id (the Codex CLI's own registration). */
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

/** OpenAI auth issuer. */
const CODEX_ISSUER = 'https://auth.openai.com';

/** OAuth authorize endpoint. */
const CODEX_AUTHORIZE_URL = `${CODEX_ISSUER}/oauth/authorize`;

/** OAuth token endpoint (code exchange + refresh). */
const CODEX_TOKEN_URL = `${CODEX_ISSUER}/oauth/token`;

/** Device-code endpoints (headless / SSH / non-TTY login). */
export const CODEX_DEVICE_USERCODE_URL = `${CODEX_ISSUER}/api/accounts/deviceauth/usercode`;
/** Where the device-code flow polls for the user's approval. */
export const CODEX_DEVICE_TOKEN_URL = `${CODEX_ISSUER}/api/accounts/deviceauth/token`;
/** Where the user enters the one-time device code. */
export const CODEX_DEVICE_VERIFICATION_URL = `${CODEX_ISSUER}/codex/device`;
/** Redirect URI used by the device-code token exchange. */
export const CODEX_DEVICE_REDIRECT_URI = `${CODEX_ISSUER}/deviceauth/callback`;

/**
 * Loopback redirect allow-list. The borrowed client id ONLY permits
 * `http://localhost:1455/auth/callback` and `http://localhost:1457/auth/callback`;
 * any other host/port/path makes auth.openai.com reject the authorize request
 * with a generic `unknown_error` before redirecting back. Do NOT pick your own
 * port. (Keep in sync with codex-rs/login/src/server.rs in openai/codex.)
 */
const CODEX_CALLBACK_HOST = 'localhost';
const CODEX_CALLBACK_PORT = 1455;
const CODEX_CALLBACK_FALLBACK_PORT = 1457;
const CODEX_CALLBACK_PATH = '/auth/callback';

/** Build the loopback redirect URI for a given port. */
function codexRedirectUri(port: number): string {
  return `http://${CODEX_CALLBACK_HOST}:${port}${CODEX_CALLBACK_PATH}`;
}

/** OAuth scopes requested at authorize time. */
const CODEX_SCOPE = 'openid profile email offline_access';

/**
 * Our OWN originator string. Deliberately NOT `codex_cli_rs` — we must not
 * impersonate the Codex CLI. Sent both as an authorize-URL param and a request
 * header.
 */
const CODEX_ORIGINATOR = 'texra';

/** JWT claim namespace holding the ChatGPT account id. */
const CODEX_JWT_AUTH_CLAIM = 'https://api.openai.com/auth';

/**
 * Secret-storage key for the persisted OAuth token bundle. Deliberately OUTSIDE
 * the `apiKey.<provider>` namespace so it never collides with the api-key scans
 * over API_KEY_PROVIDER_IDS, and so the Codex credential is never treated as an
 * api key.
 */
const CODEX_SESSION_SECRET_KEY = 'auth.chatgpt-codex';

// Schema-first: define the schemas, derive the TS types. The stored bundle is
// the canonical camelCase shape; the raw token-endpoint response is snake_case
// and transformed at the entry point.

/** Raw response from the OAuth token endpoint (code exchange + refresh). */
const CodexTokenResponseSchema = Schema.Struct({
  access_token: Schema.String.check(Schema.isMinLength(1)),
  // Refresh responses may omit a new refresh_token; the coordinator keeps the
  // previous one in that case.
  refresh_token: Schema.optional(
    Schema.NullOr(Schema.String.check(Schema.isMinLength(1))),
  ),
  id_token: Schema.optional(
    Schema.NullOr(Schema.String.check(Schema.isMinLength(1))),
  ),
  expires_in: Schema.Number,
});

/** The persisted OAuth session bundle (stored as JSON under one secret key). */
const CodexSessionSchema = SubscriptionSessionBaseSchema.mapFields(
  Struct.assign({
    accountId: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
    email: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
    /** The ChatGPT plan the token was issued for (`plus`, `pro`, `team`, ...). */
    planType: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  }),
);
/** A stored ChatGPT (Codex) session. */
export type CodexSession = typeof CodexSessionSchema.Type;

/** Device-code "usercode" response. Field name varies (`user_code`/`usercode`). */
export const CodexDeviceUserCodeSchema = Schema.Struct({
  device_auth_id: Schema.String.check(Schema.isMinLength(1)),
  user_code: Schema.optional(
    Schema.NullOr(Schema.String.check(Schema.isMinLength(1))),
  ),
  usercode: Schema.optional(
    Schema.NullOr(Schema.String.check(Schema.isMinLength(1))),
  ),
  // The endpoint sends the poll interval (seconds) as a string or a number, may
  // omit it, and could send junk. Normalize at the boundary to a positive
  // number, defaulting to 5 (matches Codex CLI / Zed).
  interval: Schema.Union([Schema.Finite, Schema.FiniteFromString])
    .check(Schema.isGreaterThan(0))
    .pipe(Schema.catchDecoding(() => Effect.succeed(Option.some(5))))
    .pipe(Schema.withDecodingDefault(Effect.succeed(5))),
  // Lifetime of the user code (seconds), same normalization policy as
  // `interval`. RFC 8628 makes this authoritative when the endpoint sends it;
  // absent or unusable, the caller applies its own fallback deadline.
  expires_in: Schema.optional(
    Schema.NullOr(
      Schema.Union([Schema.Finite, Schema.FiniteFromString]).check(
        Schema.isGreaterThan(0),
      ),
    ),
  ).pipe(Schema.catchDecoding(() => Effect.succeed(Option.some(undefined)))),
});

/** Device-code poll success: an authorization code + its PKCE verifier. */
export const CodexDeviceTokenSchema = Schema.Struct({
  authorization_code: Schema.String.check(Schema.isMinLength(1)),
  code_verifier: Schema.String.check(Schema.isMinLength(1)),
  code_challenge: Schema.optional(
    Schema.NullOr(Schema.String.check(Schema.isMinLength(1))),
  ),
});

// JWT claim extraction. We never verify the signature here (the token came
// straight from the OAuth token endpoint over TLS); we only decode the payload
// to read the ChatGPT account id and email. The `id_token` is preferred over
// the `access_token` because some accounts only carry the account id in the
// id_token.
//
// The ChatGPT plan (`plus`, `pro`, `team`, ...) rides on the same token, in
// `chatgpt_plan_type` either at the top level or under the auth claim. It is
// what the run footer names instead of calling a subscription call "free".
//
// The account id lives in one of three places (matching Zed / Roo Code):
//   1. top-level `chatgpt_account_id`
//   2. `["https://api.openai.com/auth"].chatgpt_account_id`
//   3. `organizations[0].id`
//
// The decoded payload is UNTRUSTED, so it is validated through a schema at
// the boundary instead of hand-walked with casts. Every claim self-heals
// (`catchDecoding`) so a single malformed field degrades to `undefined` rather
// than dropping the whole payload — preserving the old per-location probing
// where a valid account id survives garbage in a sibling claim. The same
// schema folds the three locations into the canonical `{ accountId, email }`
// shape.

/** Account id, email, and plan distilled from a JWT (each may be absent). */
const CodexJwtClaimsSchema = Schema.Struct({
  accountId: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
  planType: Schema.optional(Schema.String),
});
type CodexJwtClaims = typeof CodexJwtClaimsSchema.Type;

/** Validates an UNTRUSTED decoded JWT payload and distills the claims we read. */
const CodexJwtPayloadSchema = Schema.Struct({
  chatgpt_account_id: NonEmptyJwtClaim,
  chatgpt_plan_type: NonEmptyJwtClaim,
  [CODEX_JWT_AUTH_CLAIM]: Schema.optional(
    Schema.Struct({
      chatgpt_account_id: NonEmptyJwtClaim,
      chatgpt_plan_type: NonEmptyJwtClaim,
    }),
  ).pipe(Schema.catchDecoding(() => Effect.succeed(Option.some(undefined)))),
  organizations: Schema.optional(
    Schema.Array(
      Schema.Struct({ id: NonEmptyJwtClaim }).pipe(
        Schema.catchDecoding(() =>
          Effect.succeed(Option.some({ id: undefined })),
        ),
      ),
    ),
  ).pipe(Schema.catchDecoding(() => Effect.succeed(Option.some(undefined)))),
  email: NonEmptyJwtClaim,
}).pipe(
  Schema.decodeTo(CodexJwtClaimsSchema, {
    decode: SchemaGetter.transform((claims) => ({
      accountId:
        claims.chatgpt_account_id ??
        claims[CODEX_JWT_AUTH_CLAIM]?.chatgpt_account_id ??
        claims.organizations?.[0]?.id,
      email: claims.email,
      planType:
        claims.chatgpt_plan_type ??
        claims[CODEX_JWT_AUTH_CLAIM]?.chatgpt_plan_type,
    })),
    encode: SchemaGetter.forbidden(() => 'decode-only'),
  }),
);

const EMPTY_CLAIMS: CodexJwtClaims = {};

/**
 * Extract account id + email, preferring the id_token and falling back to the
 * access_token field-by-field. Either token may be absent.
 */
function extractCodexClaims(
  idToken: string | undefined,
  accessToken: string | undefined,
): CodexJwtClaims {
  const decode = (token: string): CodexJwtClaims =>
    decodeJwtClaimsWithSchema(token, CodexJwtPayloadSchema, EMPTY_CLAIMS);
  const id = idToken ? decode(idToken) : undefined;
  const access = accessToken ? decode(accessToken) : undefined;
  return {
    accountId: id?.accountId ?? access?.accountId,
    email: id?.email ?? access?.email,
    planType: id?.planType ?? access?.planType,
  };
}

/**
 * The ChatGPT sign-in policy for the shared `SubscriptionOAuthCoordinator`:
 * the authorize URL and the claims differ from Grok; single-flight refresh,
 * storage races, and error mapping live in the shared machine.
 */
const CODEX_POLICY: SubscriptionOAuthPolicy<CodexSession> = {
  sessionSchema: CodexSessionSchema,
  tokenEndpoint: {
    tokenUrl: CODEX_TOKEN_URL,
    clientId: CODEX_CLIENT_ID,
    tokenResponseSchema: CodexTokenResponseSchema,
  },
  notSignedInMessage: 'Not signed in with ChatGPT. Run sign-in first.',
  sessionChangedMessage: 'ChatGPT session changed while refreshing. Try again.',
  authorize: {
    url: CODEX_AUTHORIZE_URL,
    scope: CODEX_SCOPE,
    redirectUri: codexRedirectUri,
    params: {
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      originator: CODEX_ORIGINATOR,
    },
  },
  buildSession(tokens, refreshToken, nowMs, previous) {
    const claims = extractCodexClaims(
      tokens.id_token ?? undefined,
      tokens.access_token,
    );
    return {
      accessToken: tokens.access_token,
      refreshToken,
      idToken: tokens.id_token ?? previous?.idToken,
      expiresAtMs: nowMs + tokens.expires_in * 1000,
      accountId: claims.accountId ?? previous?.accountId,
      email: claims.email ?? previous?.email,
      planType: claims.planType ?? previous?.planType,
    };
  },
};

/**
 * The coordinator for the caller's secret store: one coordinator per store
 * instance, so distinct stores never share session state.
 */
export const codexCoordinator: (
  secrets: CredentialStore,
) => SubscriptionCoordinator<CodexSession> = createSecretBackedCoordinator({
  secretKey: CODEX_SESSION_SECRET_KEY,
  makeCoordinator: (storage) =>
    new SubscriptionOAuthCoordinator({ storage, policy: CODEX_POLICY }),
});

/** Signed-in status, read from the caller's secret store. A store that
 *  cannot be read, or a stored session that does not parse, fails. */
export function getCodexStatus(
  secrets: CredentialStore,
): Effect.Effect<
  SubscriptionSessionStatus,
  SecretsFailed | SubscriptionOAuthError
> {
  return Effect.suspend(() => codexCoordinator(secrets).getStatus());
}

/** The browser sign-in, bound to the registered ChatGPT callback. */
export const codexLoginWithLoopback = defineLoopbackLogin<CodexSession>({
  ports: [CODEX_CALLBACK_PORT, CODEX_CALLBACK_FALLBACK_PORT],
  callbackPath: CODEX_CALLBACK_PATH,
  displayName: 'ChatGPT',
});
