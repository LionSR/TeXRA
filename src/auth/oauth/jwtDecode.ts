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
 * any structural error; never throws.
 */
function decodeUnverifiedJwtPayload(
  token: string,
): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const json = Buffer.from(parts[1], 'base64url').toString('utf-8');
    const raw: unknown = JSON.parse(json);
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
      return null;
    }
    return raw as Record<string, unknown>;
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
  const raw = decodeUnverifiedJwtPayload(token);
  if (raw == null) return empty;
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : empty;
}

/**
 * Decode id_token then access_token; each listed field prefers the id_token
 * value when present (`??` coalesce, field-by-field).
 */
export function claimsPreferringIdToken<T extends object>(
  idToken: string | undefined,
  accessToken: string | undefined,
  decode: (token: string) => T,
  fields: readonly (keyof T & string)[],
): Pick<T, (typeof fields)[number]> {
  const id = idToken ? decode(idToken) : undefined;
  const access = accessToken ? decode(accessToken) : undefined;
  const out = {} as Pick<T, (typeof fields)[number]>;
  for (const field of fields) {
    out[field] = (id?.[field] ?? access?.[field]) as T[typeof field];
  }
  return out;
}
