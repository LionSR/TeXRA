/**
 * Unverified JWT payload helpers for subscription OAuth (display claims /
 * proactive refresh only — never authorization decisions).
 *
 * Tokens are assumed to come from the provider token endpoint over TLS; we
 * decode the middle segment and validate through a schema at the boundary.
 */
import { Effect, Option, Schema } from 'effect';

/** Non-empty string claim; any other shape degrades to undefined. */
export const NonEmptyJwtClaim = Schema.optional(Schema.NonEmptyString).pipe(
  Schema.catchDecoding(() => Effect.succeed(Option.some(undefined))),
);

/**
 * Decode a JWT's middle base64url segment as JSON and parse it with `schema`.
 * Returns `empty` on any structural or schema failure; never throws.
 */
export function decodeJwtClaimsWithSchema<T>(
  token: string,
  schema: Schema.Codec<T, unknown>,
  empty: T,
): T {
  const parts = token.split('.');
  if (parts.length !== 3) return empty;
  return Schema.decodeUnknownOption(Schema.fromJsonString(schema))(
    Buffer.from(parts[1], 'base64url').toString('utf-8'),
  ).pipe(Option.getOrElse(() => empty));
}
