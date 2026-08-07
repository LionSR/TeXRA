/**
 * JWT claim extraction for the xAI OAuth flow.
 *
 * We never verify the signature (the token came from the OAuth token endpoint
 * over TLS). Claims are only used for display (email) and proactive refresh
 * (`exp`) — never as an authorization decision on their own.
 */
import { z } from 'zod';

import {
  NonEmptyJwtClaim,
  decodeJwtClaimsWithSchema,
} from '../oauth/jwtDecode';

/** Account identity distilled from a JWT (any field may be absent). */
export interface XaiJwtClaims {
  email?: string;
  /** Absolute expiry (ms since epoch) when the JWT carries `exp`. */
  expiresAtMs?: number;
}

const XaiJwtClaimsSchema = z
  .object({
    email: NonEmptyJwtClaim,
    preferred_username: NonEmptyJwtClaim,
    exp: z.number().finite().optional().catch(undefined),
  })
  .transform((claims): XaiJwtClaims => ({
    email: claims.email ?? claims.preferred_username,
    expiresAtMs: claims.exp == null ? undefined : Math.trunc(claims.exp) * 1000,
  }));

const EMPTY_CLAIMS: XaiJwtClaims = {};

/**
 * Decode + validate a JWT's claims (middle base64url segment). Returns empty
 * claims on any structural error; never throws.
 */
export function decodeXaiJwtClaims(token: string): XaiJwtClaims {
  return decodeJwtClaimsWithSchema(token, XaiJwtClaimsSchema, EMPTY_CLAIMS);
}
