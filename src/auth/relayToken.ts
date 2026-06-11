/**
 * CI relay token consumption (texra setup-token).
 *
 * A CI relay token is a long-lived, relay-scoped bearer credential for
 * headless pipelines, configured through the TEXRA_RELAY_TOKEN environment
 * variable — a deliberately distinct path from the Supabase session secrets.
 * When configured, SupabaseClient.getRelayAccessToken() returns it for
 * relay-bound calls (model proxy, tier-config, usage logging). Normal Supabase
 * APIs still use GoTrue session tokens.
 */

import { z } from 'zod';

import {
  RELAY_TIER_CONFIG_URL,
  SERVER_SIDE_CACHE_TTL_MS,
  UserTierSchema,
  type UserTier,
} from './sharedConfig';
import { fetchWithTimeout } from './fetchWithTimeout';

export const RELAY_TOKEN_ENV_VAR = 'TEXRA_RELAY_TOKEN';

/**
 * Token format minted by the relay-tokens edge function.
 *
 * CROSS-REFERENCE: this exact prefix is duplicated in
 * supabase/functions/_shared/relayCiToken.ts — Deno edge functions cannot
 * import this source file, so the two definitions must be kept in sync
 * manually or minted tokens silently stop authenticating.
 */
export const RELAY_CI_TOKEN_PREFIX = 'texra_relay_';

const TIER_FETCH_TIMEOUT_MS = 30000;

/**
 * Read the configured CI relay token. Returns undefined when the variable is
 * unset, empty, or not in the minted `texra_relay_…` format — a malformed
 * value must not hijack the normal session-based auth path.
 */
export function getConfiguredRelayToken(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const raw = env[RELAY_TOKEN_ENV_VAR]?.trim();
  if (!raw || !raw.startsWith(RELAY_CI_TOKEN_PREFIX)) return undefined;
  return raw;
}

const TierConfigUserStatusSchema = z.object({
  userStatus: z
    .object({ tier: UserTierSchema.catch('free') })
    .loose()
    .nullish(),
});

/**
 * Validity of a configured CI relay token as observed via the relay's
 * tier-config endpoint — the only profile surface a relay-scoped token can
 * reach. `invalid` means the server answered and did not recognize the
 * credential (expired, revoked, or never minted); `unknown` means the check
 * itself failed (offline, 5xx) and the token may still be fine.
 */
export type RelayTokenStatus =
  | { readonly state: 'valid'; readonly tier: UserTier }
  | { readonly state: 'invalid' }
  | { readonly state: 'unknown' };

let cachedTier: { token: string; tier: UserTier; timestamp: number } | null =
  null;

/** Reset the tier cache between unit tests. */
export function resetRelayTokenTierCacheForTests(): void {
  cachedTier = null;
}

/** Check the validity and tier of a CI relay token (valid results cached). */
export async function fetchRelayTokenStatus(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RelayTokenStatus> {
  if (
    cachedTier &&
    cachedTier.token === token &&
    Date.now() - cachedTier.timestamp < SERVER_SIDE_CACHE_TTL_MS
  ) {
    return { state: 'valid', tier: cachedTier.tier };
  }
  try {
    const response = await fetchWithTimeout(
      RELAY_TIER_CONFIG_URL,
      { headers: { Authorization: `Bearer ${token}` } },
      TIER_FETCH_TIMEOUT_MS,
      'Tier lookup timed out',
      fetchImpl,
    );
    if (response.status === 401 || response.status === 403) {
      return { state: 'invalid' };
    }
    if (!response.ok) return { state: 'unknown' };
    const parsed = TierConfigUserStatusSchema.safeParse(await response.json());
    if (!parsed.success) return { state: 'unknown' };
    // tier-config returns the public config without userStatus when the
    // presented credential is not recognized (expired, revoked, malformed).
    if (!parsed.data.userStatus) return { state: 'invalid' };
    const tier = parsed.data.userStatus.tier;
    cachedTier = { token, tier, timestamp: Date.now() };
    return { state: 'valid', tier };
  } catch {
    return { state: 'unknown' };
  }
}

/**
 * Tier of the user owning a CI relay token, for model gating. Falls back to
 * 'free' whenever the token can't be verified so gating stays conservative
 * rather than blocking startup.
 */
export async function fetchRelayTokenTier(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<UserTier> {
  const status = await fetchRelayTokenStatus(token, fetchImpl);
  return status.state === 'valid' ? status.tier : 'free';
}
