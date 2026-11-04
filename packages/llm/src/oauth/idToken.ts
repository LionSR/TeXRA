/**
 * OpenID Connect ID-token verification for a subscription sign-in: an RS256
 * signature against the issuer's published keys, then the issuer, the
 * audience (the client the sign-in used), expiry and nonce. The verified
 * subject identifies the account.
 */

// Third-party imports
import { Duration, Effect, Layer, Schema } from 'effect';
import { SecureRandom, Signature } from 'effect/crypto';
import { Jwks, Jwt } from 'effect/jose';

// Local imports
import { SubscriptionOAuthError } from './subscriptionOAuthError.js';

/** The issuer whose tokens are checked, and its name in messages. */
interface IdTokenIssuer {
  readonly issuer: string;
  readonly jwksUrl: string;
  readonly name: string;
}

/** The claims read beyond the registered ones `Jwt` checks. */
const IdTokenClaimsSchema = Schema.Struct({
  nonce: Schema.String,
  sub: Schema.String.check(Schema.isMinLength(1)),
});

const JWKS_TIMEOUT = Duration.seconds(30);

const signatureLayer = Signature.layerWebCrypto.pipe(
  Layer.provide(SecureRandom.layerWebCrypto),
);

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
  const { claims } = yield* Effect.scoped(
    Effect.flatMap(
      Jwks.makeRemote({ url: issuer.jwksUrl, timeout: JWKS_TIMEOUT }),
      (jwks) =>
        Jwt.verifyWithKeySet(IdTokenClaimsSchema, token, {
          algorithms: ['RS256'],
          issuer: issuer.issuer,
          audience: attempt.clientId,
          requiredClaims: ['exp'],
        }).pipe(Effect.provideService(Jwks.Jwks, jwks)),
    ),
  ).pipe(
    Effect.provide(signatureLayer),
    Effect.mapError((cause) =>
      cause._tag === 'JoseError' && cause.reason._tag === 'KeySetUnavailable'
        ? new SubscriptionOAuthError({
            message: `Could not fetch ${issuer.name}'s signing keys: ${cause.message}`,
            kind: 'transient',
            cause,
          })
        : rejected(cause.message, cause),
    ),
  );
  if (claims.nonce !== attempt.nonce)
    return yield* rejected('another sign-in attempt');
  return claims.sub;
});
