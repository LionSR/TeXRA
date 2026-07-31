/**
 * Shared validation for CI relay tokens (texra setup-token).
 *
 * CI tokens are long-lived bearer credentials for headless pipelines,
 * distinct from Supabase sessions: recognized by the `texra_relay_` prefix,
 * stored only as SHA-256 hashes in public.relay_ci_tokens (service-role
 * only), and scoped to relay invocation. The relay and log-usage functions
 * use this helper to map a presented token to its owning user.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { authenticateJwt } from './auth.ts';
import { sha256Hex } from './crypto.ts';

/**
 * CROSS-REFERENCE: this exact prefix is duplicated in src/auth/relayToken.ts
 * — Deno edge functions cannot share source with the clients, so the two
 * definitions must be kept in sync manually or minted tokens silently stop
 * authenticating.
 */
export const RELAY_CI_TOKEN_PREFIX = 'texra_relay_';

/** Refresh last_used_at at most this often to avoid per-request writes. */
const LAST_USED_REFRESH_MS = 60 * 1000;

function isRelayCiToken(token: string): boolean {
  return token.startsWith(RELAY_CI_TOKEN_PREFIX);
}

type CiTokenAuthResult =
  { ok: true; userId: string } | { ok: false; status: number; message: string };

/**
 * Validate a CI relay token: hash lookup, revocation, expiry, and scope.
 * Refreshes last_used_at (throttled) as audit metadata on success.
 */
async function authenticateRelayCiToken(
  adminClient: SupabaseClient<any>,
  token: string,
  requiredScope = 'relay',
): Promise<CiTokenAuthResult> {
  const tokenHash = await sha256Hex(token);
  const { data: row, error } = await adminClient
    .from('relay_ci_tokens')
    .select('id, user_id, scopes, expires_at, revoked_at, last_used_at')
    .eq('token_hash', tokenHash)
    .maybeSingle();

  if (error) {
    console.error('[CI_TOKEN] lookup failed:', error.message);
    return { ok: false, status: 500, message: 'Internal server error' };
  }
  if (!row) {
    return { ok: false, status: 401, message: 'Invalid or expired token' };
  }
  if (row.revoked_at) {
    return { ok: false, status: 401, message: 'This CI token was revoked' };
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return {
      ok: false,
      status: 401,
      message:
        'This CI token has expired. Mint a new one with `texra setup-token`.',
    };
  }
  const scopes: string[] = Array.isArray(row.scopes) ? row.scopes : [];
  if (!scopes.includes(requiredScope)) {
    return {
      ok: false,
      status: 403,
      message: `This CI token is not scoped for ${requiredScope} access`,
    };
  }

  const lastUsed = row.last_used_at ? new Date(row.last_used_at).getTime() : 0;
  if (Date.now() - lastUsed > LAST_USED_REFRESH_MS) {
    // Best-effort audit timestamp; never block the request on it.
    void adminClient
      .from('relay_ci_tokens')
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', row.id)
      .then(({ error: updateError }: { error: { message: string } | null }) => {
        if (updateError) {
          console.warn(
            '[CI_TOKEN] last_used_at update failed:',
            updateError.message,
          );
        }
      });
  }

  return { ok: true, userId: row.user_id };
}

export type RelayCredentialResolution =
  | { ok: true; userId: string; profileClient: SupabaseClient<any> }
  | { ok: false; status: number; message: string };

/**
 * Resolve a relay-facing bearer credential — a normal user JWT or a CI relay
 * token — to the owning user plus a client that can read that user's profile
 * (RLS-scoped for JWTs; service-role for CI tokens, which carry no JWT, so
 * callers must filter by the returned userId explicitly).
 */
export async function resolveRelayCredential(
  token: string,
  adminClient: SupabaseClient<any> | null,
): Promise<RelayCredentialResolution> {
  if (isRelayCiToken(token)) {
    if (!adminClient) {
      console.error(
        '[CI_TOKEN] CI token presented but service role key missing',
      );
      return { ok: false, status: 500, message: 'Server configuration error' };
    }
    const ciAuth = await authenticateRelayCiToken(adminClient, token);
    if (!ciAuth.ok) return ciAuth;
    return { ok: true, userId: ciAuth.userId, profileClient: adminClient };
  }
  const auth = await authenticateJwt(token);
  if (!auth) {
    return { ok: false, status: 401, message: 'Invalid or expired token' };
  }
  return { ok: true, userId: auth.user.id, profileClient: auth.client };
}
