/**
 * JWT claim extraction for the Codex OAuth flow.
 *
 * We never verify the signature here (the token came straight from the OAuth
 * token endpoint over TLS); we only decode the payload to read the ChatGPT
 * account id and email. The `id_token` is preferred over the `access_token`
 * because some accounts only carry the account id in the id_token.
 *
 * The account id lives in one of three places (matching Zed / Roo Code):
 *   1. top-level `chatgpt_account_id`
 *   2. `["https://api.openai.com/auth"].chatgpt_account_id`
 *   3. `organizations[0].id`
 *
 * The decoded payload is UNTRUSTED, so it is validated through a Zod schema at
 * the boundary instead of hand-walked with casts. Every claim self-heals
 * (`.catch`) so a single malformed field degrades to `undefined` rather than
 * dropping the whole payload — preserving the old per-location probing where a
 * valid account id survives garbage in a sibling claim. The same schema folds
 * the three locations into the canonical `{ accountId, email }` shape.
 */
import { z } from 'zod';

import {
  NonEmptyJwtClaim,
  claimsPreferringIdToken,
  decodeJwtClaimsWithSchema,
} from '../oauth/jwtDecode';
import { CODEX_JWT_AUTH_CLAIM } from './codexConstants';

/** Account id + email distilled from a JWT (either may be absent). */
export interface CodexJwtClaims {
  accountId?: string;
  email?: string;
}

/** Validates an UNTRUSTED decoded JWT payload and distills the claims we read. */
const CodexJwtClaimsSchema = z
  .object({
    chatgpt_account_id: NonEmptyJwtClaim,
    [CODEX_JWT_AUTH_CLAIM]: z
      .object({ chatgpt_account_id: NonEmptyJwtClaim })
      .optional()
      .catch(undefined),
    organizations: z
      .array(z.object({ id: NonEmptyJwtClaim }).catch({ id: undefined }))
      .optional()
      .catch(undefined),
    email: NonEmptyJwtClaim,
  })
  .transform((claims): CodexJwtClaims => ({
    accountId:
      claims.chatgpt_account_id ??
      claims[CODEX_JWT_AUTH_CLAIM]?.chatgpt_account_id ??
      claims.organizations?.[0]?.id,
    email: claims.email,
  }));

const EMPTY_CLAIMS: CodexJwtClaims = {};

/**
 * Extract account id + email, preferring the id_token and falling back to the
 * access_token field-by-field. Either token may be absent.
 */
export function extractCodexClaims(
  idToken: string | undefined,
  accessToken: string | undefined,
): CodexJwtClaims {
  return claimsPreferringIdToken(
    idToken,
    accessToken,
    (token) =>
      decodeJwtClaimsWithSchema(token, CodexJwtClaimsSchema, EMPTY_CLAIMS),
    ['accountId', 'email'],
  );
}
