/**
 * "Sign in with ChatGPT": OpenAI's token sharing for open-source agents, in
 * which a ChatGPT plan pays for Responses API calls the user's own agent
 * makes. Its constants, session schema, ID-token check, OAuth policy, and the
 * coordinator and loopback sign-in bound to them.
 *
 * The first sign-in registers a client for the user (`dynamic_agent_client`),
 * and every later grant uses the client OpenAI issued then. Tokens are scoped
 * to the public Responses API (`resource`), which `resolveRouteEndpoint`
 * names for the subscription route
 * (`../../models/routeEndpoint.ts`). Keep every sign-in magic value here, so
 * an upstream change is a one-file edit.
 *
 * Source: developers.openai.com/siwc/token-sharing-open-source (register an
 * open-source client; models and inference; preview limitations).
 */

// Node imports
import { createPublicKey, randomUUID, verify } from 'node:crypto';

// Third-party imports
import {
  Clock,
  Duration,
  Effect,
  Option,
  Result,
  Schema,
  SchemaGetter,
  Struct,
} from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/http';

// Local imports
import { NonEmptyJwtClaim, decodeJwtClaimsWithSchema } from '../jwtDecode.js';
import { defineLoopbackLogin } from '../loopbackLogin.js';
import { SubscriptionOAuthCoordinator } from '../SubscriptionOAuthCoordinator.js';
import { SubscriptionOAuthError } from '../subscriptionOAuthError.js';
import {
  SubscriptionSessionBaseSchema,
  SubscriptionTokenResponseSchema,
} from '../subscriptionSessionSchema.js';
import { toErrorMessage } from '../support.js';
import type {
  CredentialStore,
  SecretsFailed,
} from '../../providers/credentials.js';
import type {
  SubscriptionCoordinator,
  SubscriptionOAuthPolicy,
  SubscriptionSessionStatus,
  SubscriptionTokenResponse,
} from '../subscriptionCoordinator.js';

/** OpenAI auth issuer; also the ID token's `iss`. */
const CHATGPT_ISSUER = 'https://auth.openai.com';

const CHATGPT_AUTHORIZE_URL = `${CHATGPT_ISSUER}/api/accounts/authorize`;
const CHATGPT_TOKEN_URL = `${CHATGPT_ISSUER}/api/accounts/oauth/token`;
const CHATGPT_JWKS_URL = `${CHATGPT_ISSUER}/.well-known/jwks.json`;

/** The API the tokens are issued for, sent with the authorize request and
 *  every grant. */
const CHATGPT_RESOURCE = 'https://api.openai.com/v1';

/** The scope that lets the plan pay for inference. A user can decline it on
 *  the consent page, which leaves a token good for identity only. */
const TOKEN_SHARING_SCOPE = 'chatgpt.tokens.use.direct';

const CHATGPT_SCOPE = `openid profile email offline_access resource.invoke ${TOKEN_SHARING_SCOPE}`;

/** The reserved client id a first sign-in registers through. */
const REGISTRATION_CLIENT_ID = 'dynamic_agent_client';

/** The name OpenAI shows for the client a first sign-in registers. */
const AGENT_NAME = 'TeXRA';

/**
 * The loopback callback. Only the port may differ between sign-ins, and the
 * host must be `127.0.0.1`, not `localhost`. 1455 first, as OpenAI's
 * examples use; any free port when it is taken.
 */
const CHATGPT_CALLBACK_PORTS = [1455, 0];
const CHATGPT_CALLBACK_PATH = '/auth/callback';

/**
 * Secret-storage keys. Outside the `apiKey.<provider>` namespace so they never
 * collide with the API-key scans, and so the session is never read as a key.
 * The host id outlives sign-out: OpenAI asks for one stable id per machine.
 */
const CHATGPT_SESSION_SECRET_KEY = 'auth.chatgpt';
const CHATGPT_HOST_ID_SECRET_KEY = 'auth.chatgpt.host-id';

/** The persisted OAuth session bundle (stored as JSON under one secret key). */
const ChatgptSessionSchema = SubscriptionSessionBaseSchema.mapFields(
  Struct.assign({
    accountId: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
    email: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
    /** The ChatGPT plan the token was issued for (`plus`, `pro`, ...). */
    planType: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  }),
);
/** A stored ChatGPT session. */
export type ChatgptSession = typeof ChatgptSessionSchema.Type;

// Display claims. The ID token's signature is checked once, at sign-in
// (`verifyIdToken`); these reads only name the account and plan in the UI, so
// a malformed claim degrades to `undefined` instead of failing the session.

/** JWT claim namespace holding the ChatGPT account id and plan. */
const CHATGPT_AUTH_CLAIM = 'https://api.openai.com/auth';

const ChatgptClaimsSchema = Schema.Struct({
  accountId: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
  planType: Schema.optional(Schema.String),
});
type ChatgptClaims = typeof ChatgptClaimsSchema.Type;

/** Validates an untrusted decoded JWT payload and distills the claims read. */
const ChatgptJwtPayloadSchema = Schema.Struct({
  chatgpt_account_id: NonEmptyJwtClaim,
  chatgpt_plan_type: NonEmptyJwtClaim,
  [CHATGPT_AUTH_CLAIM]: Schema.optional(
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
  Schema.decodeTo(ChatgptClaimsSchema, {
    decode: SchemaGetter.transform((claims) => ({
      accountId:
        claims.chatgpt_account_id ??
        claims[CHATGPT_AUTH_CLAIM]?.chatgpt_account_id ??
        claims.organizations?.[0]?.id,
      email: claims.email,
      planType:
        claims.chatgpt_plan_type ??
        claims[CHATGPT_AUTH_CLAIM]?.chatgpt_plan_type,
    })),
    encode: SchemaGetter.forbidden(() => 'decode-only'),
  }),
);

const EMPTY_CLAIMS: ChatgptClaims = {};

/** Account id, email and plan, from the ID token first, field by field. */
function extractChatgptClaims(
  idToken: string | undefined,
  accessToken: string | undefined,
): ChatgptClaims {
  const decode = (token: string): ChatgptClaims =>
    decodeJwtClaimsWithSchema(token, ChatgptJwtPayloadSchema, EMPTY_CLAIMS);
  const id = idToken ? decode(idToken) : undefined;
  const access = accessToken ? decode(accessToken) : undefined;
  return {
    accountId: id?.accountId ?? access?.accountId,
    email: id?.email ?? access?.email,
    planType: id?.planType ?? access?.planType,
  };
}

// ID-token verification: RS256 against OpenAI's published keys, then the
// issuer, the audience (the client this sign-in used), expiry and nonce.

const IdTokenHeaderSchema = Schema.Struct({
  alg: Schema.Literal('RS256'),
  kid: Schema.String,
});
const IdTokenPayloadSchema = Schema.Struct({
  iss: Schema.Literal(CHATGPT_ISSUER),
  aud: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  exp: Schema.Finite,
  nonce: Schema.String,
  sub: Schema.String.check(Schema.isMinLength(1)),
});
/** The RSA members `createPublicKey` reads; a key of another type fails to
 *  import and is reported as unusable. */
const JwksSchema = Schema.Struct({
  keys: Schema.Array(
    Schema.Struct({
      kid: Schema.optional(Schema.String),
      kty: Schema.String,
      n: Schema.optional(Schema.String),
      e: Schema.optional(Schema.String),
    }),
  ),
});

const JWKS_TIMEOUT = Duration.seconds(30);

const rejectedIdToken = (reason: string, cause?: unknown) =>
  new SubscriptionOAuthError({
    message: `ChatGPT sign-in returned an ID token that does not verify (${reason}). Sign in again.`,
    kind: 'config',
    cause,
  });

const decodeSegment = <T>(
  segment: string,
  schema: Schema.Codec<T, unknown>,
  part: string,
) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(
    Buffer.from(segment, 'base64url').toString('utf-8'),
  ).pipe(Effect.mapError((cause) => rejectedIdToken(`its ${part}`, cause)));

/** OpenAI's signing keys. */
const fetchJwks = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const text = yield* Effect.scoped(
    Effect.flatMap(
      HttpClient.withScope(HttpClient.filterStatusOk(client)).execute(
        HttpClientRequest.get(CHATGPT_JWKS_URL),
      ),
      (response) => response.text,
    ),
  ).pipe(
    Effect.timeout(JWKS_TIMEOUT),
    Effect.mapError(
      (cause) =>
        new SubscriptionOAuthError({
          message: `Could not fetch OpenAI's signing keys: ${toErrorMessage(cause)}`,
          kind: 'transient',
          cause,
        }),
    ),
  );
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(JwksSchema))(
    text,
  ).pipe(Effect.mapError((cause) => rejectedIdToken('signing keys', cause)));
});

const verifyIdToken = Effect.fn('chatgpt.verifyIdToken')(function* (
  token: string,
  attempt: { readonly clientId: string; readonly nonce: string },
) {
  const parts = token.split('.');
  if (parts.length !== 3) return yield* rejectedIdToken('not a JWT');
  const [header, payload, signature] = parts;
  const { kid } = yield* decodeSegment(header, IdTokenHeaderSchema, 'header');
  const jwk = (yield* fetchJwks).keys.find((key) => key.kid === kid);
  if (jwk === undefined) return yield* rejectedIdToken('unknown signing key');
  const signed = Result.try({
    try: () =>
      verify(
        'sha256',
        Buffer.from(`${header}.${payload}`),
        createPublicKey({ key: jwk, format: 'jwk' }),
        Buffer.from(signature, 'base64url'),
      ),
    catch: (cause) => rejectedIdToken('unusable signing key', cause),
  });
  if (Result.isFailure(signed)) return yield* signed.failure;
  if (!signed.success) return yield* rejectedIdToken('bad signature');
  const claims = yield* decodeSegment(payload, IdTokenPayloadSchema, 'claims');
  const audiences = typeof claims.aud === 'string' ? [claims.aud] : claims.aud;
  if (!audiences.includes(attempt.clientId))
    return yield* rejectedIdToken('another client');
  if (claims.exp * 1000 <= (yield* Clock.currentTimeMillis))
    return yield* rejectedIdToken('expired');
  if (claims.nonce !== attempt.nonce)
    return yield* rejectedIdToken('another sign-in attempt');
});

/** A code grant is accepted only with plan usage granted and a verified ID
 *  token: the token alone does not authorize plan usage. */
const acceptChatgptGrant = Effect.fn('chatgpt.acceptGrant')(function* (
  tokens: SubscriptionTokenResponse,
  clientId: string,
  nonce: string,
) {
  if (!tokens.scope?.split(' ').includes(TOKEN_SHARING_SCOPE)) {
    return yield* new SubscriptionOAuthError({
      message:
        'ChatGPT sign-in finished without plan usage. Sign in again and allow TeXRA to use your ChatGPT plan, or use an OpenAI API key.',
      kind: 'config',
    });
  }
  if (!tokens.id_token) {
    return yield* new SubscriptionOAuthError({
      message: 'ChatGPT sign-in did not return an ID token. Sign in again.',
      kind: 'config',
    });
  }
  yield* verifyIdToken(tokens.id_token, { clientId, nonce });
});

/** This machine's stable id for OpenAI, created on first use. */
const hostId = Effect.fn('chatgpt.hostId')(function* (
  secrets: CredentialStore,
): Effect.fn.Return<string, SecretsFailed> {
  const stored = yield* secrets.get(CHATGPT_HOST_ID_SECRET_KEY);
  if (stored) return stored;
  const created = `urn:uuid:${randomUUID()}`;
  yield* secrets.set(CHATGPT_HOST_ID_SECRET_KEY, created);
  return created;
});

/**
 * The ChatGPT sign-in policy for the shared `SubscriptionOAuthCoordinator`.
 * Single-flight refresh, storage races and error mapping live in the shared
 * machine; this names the endpoints, the per-user client and the grant check.
 */
const CHATGPT_POLICY: SubscriptionOAuthPolicy<ChatgptSession> = {
  secretKey: CHATGPT_SESSION_SECRET_KEY,
  sessionSchema: ChatgptSessionSchema,
  tokenEndpoint: {
    tokenUrl: CHATGPT_TOKEN_URL,
    // Every stored session carries the client it registered; this is only
    // the registration id the first authorize request names.
    clientId: REGISTRATION_CLIENT_ID,
    tokenResponseSchema: SubscriptionTokenResponseSchema,
    params: { resource: CHATGPT_RESOURCE },
  },
  notSignedInMessage: 'Not signed in with ChatGPT. Run sign-in first.',
  sessionChangedMessage: 'ChatGPT session changed while refreshing. Try again.',
  authorize: {
    url: CHATGPT_AUTHORIZE_URL,
    scope: CHATGPT_SCOPE,
    redirectUri: (port) => `http://127.0.0.1:${port}${CHATGPT_CALLBACK_PATH}`,
    params: { resource: CHATGPT_RESOURCE },
  },
  // A returning sign-in reauthorizes the client the stored session holds; it
  // sends no name hint, which only a registration takes.
  registration: (previous, secrets) =>
    Effect.map(hostId(secrets), (host) => {
      const registered = previous?.clientId;
      const params: Readonly<Record<string, string>> =
        registered === undefined
          ? { ext_agent_host_id: host, agent_name_hint: AGENT_NAME }
          : { ext_agent_host_id: host };
      return {
        clientId: registered ?? REGISTRATION_CLIENT_ID,
        registering: registered === undefined,
        params,
      };
    }),
  acceptGrant: acceptChatgptGrant,
  buildSession(tokens, refreshToken, nowMs, previous) {
    const claims = extractChatgptClaims(
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
export const chatgptCoordinator: (
  secrets: CredentialStore,
) => SubscriptionCoordinator<ChatgptSession> =
  SubscriptionOAuthCoordinator.forProvider(CHATGPT_POLICY);

/** Signed-in status, read from the caller's secret store. A store that
 *  cannot be read, or a stored session that does not parse, fails. */
export function getChatgptStatus(
  secrets: CredentialStore,
): Effect.Effect<
  SubscriptionSessionStatus,
  SecretsFailed | SubscriptionOAuthError
> {
  return Effect.suspend(() => chatgptCoordinator(secrets).getStatus());
}

/** The browser sign-in, on the loopback callback OpenAI accepts. */
export const chatgptLoginWithLoopback = defineLoopbackLogin<ChatgptSession>({
  ports: CHATGPT_CALLBACK_PORTS,
  callbackPath: CHATGPT_CALLBACK_PATH,
  displayName: 'ChatGPT',
});
