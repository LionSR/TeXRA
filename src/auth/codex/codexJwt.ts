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
 */
import { CODEX_JWT_AUTH_CLAIM } from './codexConstants';

export interface CodexJwtClaims {
  accountId?: string;
  email?: string;
}

/** Decode a JWT payload (the middle base64url segment). Returns null on any error. */
export function decodeJwtPayload(
  token: string,
): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const json = Buffer.from(parts[1], 'base64url').toString('utf-8');
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Extract the ChatGPT account id from a decoded payload, trying all 3 locations. */
export function extractAccountId(
  claims: Record<string, unknown>,
): string | undefined {
  const topLevel = asString(claims['chatgpt_account_id']);
  if (topLevel) return topLevel;

  const auth = claims[CODEX_JWT_AUTH_CLAIM];
  if (auth && typeof auth === 'object') {
    const nested = asString(
      (auth as Record<string, unknown>)['chatgpt_account_id'],
    );
    if (nested) return nested;
  }

  const organizations = claims['organizations'];
  if (Array.isArray(organizations) && organizations.length > 0) {
    const first = organizations[0];
    if (first && typeof first === 'object') {
      const orgId = asString((first as Record<string, unknown>)['id']);
      if (orgId) return orgId;
    }
  }
  return undefined;
}

/** Extract the email claim from a decoded payload. */
export function extractEmail(
  claims: Record<string, unknown>,
): string | undefined {
  return asString(claims['email']);
}

/**
 * Extract account id + email, preferring the id_token and falling back to the
 * access_token. Either token may be absent.
 */
export function extractCodexClaims(
  idToken: string | undefined,
  accessToken: string | undefined,
): CodexJwtClaims {
  const jwt = idToken || accessToken;
  if (!jwt) return {};
  const claims = decodeJwtPayload(jwt);
  if (!claims) return {};
  return { accountId: extractAccountId(claims), email: extractEmail(claims) };
}
