/**
 * Unverified JWT payload helpers for subscription OAuth (display claims /
 * proactive refresh only — never authorization decisions).
 *
 * Tokens are assumed to come from the provider token endpoint over TLS; we
 * decode the middle segment and validate through a Zod schema at the boundary.
 */
import { z } from 'zod';

/** Non-empty string claim; any other shape degrades to undefined. */
export const NonEmptyJwtClaim = z.string().min(1).optional().catch(undefined);

/**
 * Decode the middle base64url segment of a JWT to raw JSON. Returns `null` on
 * any structural error; never throws. The caller's object schema rejects a
 * payload that is not a JSON object.
 */
function decodeUnverifiedJwtPayload(token: string): unknown {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
}

/**
 * Decode a JWT payload and parse it with `schema`. Returns `empty` on any
 * structural or schema failure; never throws.
 */
export function decodeJwtClaimsWithSchema<T>(
  token: string,
  schema: z.ZodType<T>,
  empty: T,
): T {
  const parsed = schema.safeParse(decodeUnverifiedJwtPayload(token));
  return parsed.success ? parsed.data : empty;
}
