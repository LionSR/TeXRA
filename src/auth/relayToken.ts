/**
 * CI relay token consumption (texra setup-token).
 *
 * A CI relay token is a long-lived, relay-scoped bearer credential for
 * headless pipelines, configured through the TEXRA_RELAY_TOKEN environment
 * variable — a deliberately distinct path from the Supabase session secrets.
 * When configured, SupabaseClient.getAccessToken() returns it, so every
 * relay-bound call (model proxy, tier-config, usage logging) presents it;
 * the server maps it to the owning user and enforces scope, expiry, and
 * revocation hash-at-rest.
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

/** Token format minted by the relay-tokens edge function. */
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

let cachedTier: { token: string; tier: UserTier; timestamp: number } | null =
  null;

/** Reset the tier cache between unit tests. */
export function resetRelayTokenTierCacheForTests(): void {
  cachedTier = null;
}

/**
 * Resolve the tier of the user owning a CI relay token via the relay's
 * tier-config endpoint (the only profile surface a relay-scoped token can
 * reach). Falls back to 'free' on any failure so model gating stays
 * conservative rather than blocking startup.
 */
export async function fetchRelayTokenTier(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<UserTier> {
  if (
    cachedTier &&
    cachedTier.token === token &&
    Date.now() - cachedTier.timestamp < SERVER_SIDE_CACHE_TTL_MS
  ) {
    return cachedTier.tier;
  }
  try {
    const response = await fetchWithTimeout(
      RELAY_TIER_CONFIG_URL,
      { headers: { Authorization: `Bearer ${token}` } },
      TIER_FETCH_TIMEOUT_MS,
      'Tier lookup timed out',
      fetchImpl,
    );
    if (!response.ok) return 'free';
    const parsed = TierConfigUserStatusSchema.safeParse(await response.json());
    const tier = parsed.success
      ? (parsed.data.userStatus?.tier ?? 'free')
      : 'free';
    cachedTier = { token, tier, timestamp: Date.now() };
    return tier;
  } catch {
    return 'free';
  }
}
