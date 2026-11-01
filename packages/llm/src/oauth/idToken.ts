/**
 * OpenID Connect ID-token verification for a subscription sign-in: an RS256
 * signature against the issuer's published keys, then the issuer, the
 * audience (the client the sign-in used), expiry and nonce. The verified
 * subject identifies the account.
 */

// Node imports
import { createPublicKey, verify } from 'node:crypto';

// Third-party imports
import { Clock, Duration, Effect, Result, Schema } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/http';

// Local imports
import { SubscriptionOAuthError } from './subscriptionOAuthError.js';
import { toErrorMessage } from './support.js';

/** The issuer whose tokens are checked, and its name in messages. */
interface IdTokenIssuer {
  readonly issuer: string;
  readonly jwksUrl: string;
  readonly name: string;
}

const IdTokenHeaderSchema = Schema.Struct({
  alg: Schema.Literal('RS256'),
  kid: Schema.String,
});
const IdTokenPayloadSchema = Schema.Struct({
  iss: Schema.String,
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

/** The subject of `token`, verified for `attempt`'s client and nonce. */
export const verifyIdToken = Effect.fn('idToken.verify')(function* (
  issuer: IdTokenIssuer,
  token: string,
  attempt: { readonly clientId: string; readonly nonce: string },
) {
  const rejected = (reason: string, cause?: unknown) =>
    new SubscriptionOAuthError({
      message: `${issuer.name} sign-in returned an ID token that does not verify (${reason}). Sign in again.`,
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
    ).pipe(Effect.mapError((cause) => rejected(`its ${part}`, cause)));

  const parts = token.split('.');
  if (parts.length !== 3) return yield* rejected('not a JWT');
  const [header, payload, signature] = parts;
  const { kid } = yield* decodeSegment(header, IdTokenHeaderSchema, 'header');
  const keysText = yield* Effect.scoped(
    Effect.flatMap(
      Effect.flatMap(HttpClient.HttpClient, (client) =>
        HttpClient.withScope(HttpClient.filterStatusOk(client)).execute(
          HttpClientRequest.get(issuer.jwksUrl),
        ),
      ),
      (response) => response.text,
    ),
  ).pipe(
    Effect.timeout(JWKS_TIMEOUT),
    Effect.mapError(
      (cause) =>
        new SubscriptionOAuthError({
          message: `Could not fetch ${issuer.name}'s signing keys: ${toErrorMessage(cause)}`,
          kind: 'transient',
          cause,
        }),
    ),
  );
  const { keys } = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(JwksSchema),
  )(keysText).pipe(
    Effect.mapError((cause) => rejected('its signing keys', cause)),
  );
  const jwk = keys.find((key) => key.kid === kid);
  if (jwk === undefined) return yield* rejected('unknown signing key');
  const signed = Result.try({
    try: () =>
      verify(
        'sha256',
        Buffer.from(`${header}.${payload}`),
        createPublicKey({ key: jwk, format: 'jwk' }),
        Buffer.from(signature, 'base64url'),
      ),
    catch: (cause) => rejected('unusable signing key', cause),
  });
  if (Result.isFailure(signed)) return yield* signed.failure;
  if (!signed.success) return yield* rejected('bad signature');
  const claims = yield* decodeSegment(payload, IdTokenPayloadSchema, 'claims');
  const audiences = typeof claims.aud === 'string' ? [claims.aud] : claims.aud;
  if (claims.iss !== issuer.issuer) return yield* rejected('another issuer');
  if (!audiences.includes(attempt.clientId))
    return yield* rejected('another client');
  if (claims.exp * 1000 <= (yield* Clock.currentTimeMillis))
    return yield* rejected('expired');
  if (claims.nonce !== attempt.nonce)
    return yield* rejected('another sign-in attempt');
  return claims.sub;
});
