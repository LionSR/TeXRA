/**
 * Unverified JWT payload helpers for subscription OAuth (display claims /
 * proactive refresh only — never authorization decisions).
 *
 * Tokens are assumed to come from the provider token endpoint over TLS; we
 * decode the middle segment and validate through a schema at the boundary.
 */
import { Effect, Option, Schema } from 'effect';

/**
 * An optional field of a provider's reply where a value of another shape
 * reads as absent instead of failing the whole reply. For display claims and
 * hints only: a field the flow cannot continue without stays strict.
 */
export const absentWhenInvalid = <S extends Schema.Top>(schema: S) =>
  Schema.optional(schema).pipe(
    Schema.catchDecoding(() => Effect.succeed(Option.some(undefined))),
  );

/** Non-empty string claim; any other shape degrades to undefined. */
export const NonEmptyJwtClaim = absentWhenInvalid(Schema.NonEmptyString);

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
