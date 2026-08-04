/**
 * JWT claim extraction for the xAI OAuth flow.
 *
 * We never verify the signature (the token came from the OAuth token endpoint
 * over TLS). Claims are only used for display (email) and proactive refresh
 * (`exp`) — never as an authorization decision on their own.
 */
import { z } from 'zod';

/** Account identity distilled from a JWT (any field may be absent). */
export interface XaiJwtClaims {
  email?: string;
  /** Absolute expiry (ms since epoch) when the JWT carries `exp`. */
  expiresAtMs?: number;
}

const NonEmptyClaim = z.string().min(1).optional().catch(undefined);

const XaiJwtClaimsSchema = z
  .object({
    email: NonEmptyClaim,
    preferred_username: NonEmptyClaim,
    exp: z.number().finite().optional().catch(undefined),
  })
  .transform((claims): XaiJwtClaims => ({
    email: claims.email ?? claims.preferred_username,
    expiresAtMs: claims.exp == null ? undefined : Math.trunc(claims.exp) * 1000,
  }));

/**
 * Decode + validate a JWT's claims (middle base64url segment). Returns empty
 * claims on any structural error; never throws.
 */
export function decodeXaiJwtClaims(token: string): XaiJwtClaims {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return {};
    const json = Buffer.from(parts[1], 'base64url').toString('utf-8');
    return XaiJwtClaimsSchema.catch({}).parse(JSON.parse(json));
  } catch {
    return {};
  }
}

/**
 * Extract email (and optional exp) preferring the id_token, falling back to
 * the access_token field-by-field.
 */
export function extractXaiClaims(
  idToken: string | undefined,
  accessToken: string | undefined,
): XaiJwtClaims {
  const idClaims = idToken ? decodeXaiJwtClaims(idToken) : {};
  const accessClaims = accessToken ? decodeXaiJwtClaims(accessToken) : {};
  return {
    email: idClaims.email ?? accessClaims.email,
    expiresAtMs: idClaims.expiresAtMs ?? accessClaims.expiresAtMs,
  };
}

/**
 * Whether a JWT access token is inside the refresh skew window. Opaque or
 * non-expiring tokens return false so the stored `expiresAtMs` (or a live 401)
 * drives refresh instead.
 */
export function accessTokenIsExpiring(
  token: string | undefined,
  nowMs: number,
  skewMs: number,
): boolean {
  if (!token) return false;
  const expMs = decodeXaiJwtClaims(token).expiresAtMs;
  if (expMs == null) return false;
  return expMs <= nowMs + Math.max(0, skewMs);
}
