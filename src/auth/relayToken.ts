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

import { LRUCache } from 'lru-cache';
import { z } from 'zod';

import { INCLUDED_ACCESS } from '@shared/copy/modelAccess';

import {
  FREE_TIER,
  RELAY_TIER_CONFIG_URL,
  SERVER_SIDE_CACHE_TTL_MS,
  UserTierSchema,
  type UserTier,
} from './config';
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

/**
 * Sign-out notice for the GUI hosts when a CI relay token stays configured.
 * Clearing the stored session does not unset the environment TeXRA was
 * launched with, so relay access survives sign-out and the user keeps working
 * with no login banner and no explanation. The CLI reports the same fact with
 * terminal-specific advice (`relayTokenStillActiveNotice`); a GUI app cannot
 * point at "this shell", so it names the launch environment instead.
 */
export function relayTokenSignOutNotice(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!getConfiguredRelayToken(env)) return undefined;
  return `The ${RELAY_TOKEN_ENV_VAR} environment variable still keeps ${INCLUDED_ACCESS.inline} active; remove it from the environment TeXRA was launched with to fully sign out.`;
}

const TierConfigUserStatusSchema = z.object({
  userStatus: z
    // A present malformed tier is a relay contract failure, not a free tier.
    .object({
      tier: UserTierSchema.nullable().transform((tier) => tier ?? FREE_TIER),
    })
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

/** Settled (non-`unknown`) statuses are cached; `unknown` is always re-probed. */
type SettledRelayTokenStatus = Exclude<RelayTokenStatus, { state: 'unknown' }>;

// A single slot: setting a new token evicts whatever was cached for the
// previous one, matching the old "only the last-checked token stays fresh"
// behavior while letting `lru-cache` own TTL expiry instead of a hand-rolled
// timestamp comparison.
const statusCache = new LRUCache<string, SettledRelayTokenStatus>({
  max: 1,
  ttl: SERVER_SIDE_CACHE_TTL_MS,
});

/** Reset the status cache between unit tests. */
export function resetRelayTokenTierCacheForTests(): void {
  statusCache.clear();
}

/**
 * Last settled status of a token, without any network I/O. Lets synchronous
 * credential checks (SupabaseClient.isAuthenticated / getRelayAccessToken)
 * agree with the async surfaces that probed the server, while staying
 * deterministic and offline-safe when nothing has probed yet.
 */
export function getCachedRelayTokenState(
  token: string,
): SettledRelayTokenStatus['state'] | undefined {
  return statusCache.get(token)?.state;
}

/**
 * Record that the relay rejected this token with a 401 — authoritative
 * evidence equivalent to a probed `invalid`, so every credential check
 * (auth status, isAuthenticated, relay-call fallback) agrees immediately
 * instead of waiting out the cache TTL.
 */
export function markRelayTokenRejected(token: string): void {
  statusCache.set(token, { state: 'invalid' });
}

/** Check the validity and tier of a CI relay token (settled results cached). */
export async function fetchRelayTokenStatus(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RelayTokenStatus> {
  const cached = statusCache.get(token);
  if (cached) return cached;
  const result = await probeRelayTokenStatus(token, fetchImpl);
  // Re-read immediately before returning/writing: a concurrent live 401
  // (markRelayTokenRejected) may have landed while this probe was in
  // flight, and is authoritative evidence fresher than whatever the probe
  // observed. `invalid` is sticky against a stale probe result — even an
  // `unknown` one — until an explicit cache reset or TTL expiry clears it.
  // Checking this ahead of the `result.state !== 'unknown'` cache-write
  // guard (rather than inside it) keeps the *return value* consistent with
  // the cache for every probe outcome, not just settled ones.
  const current = statusCache.get(token);
  if (current?.state === 'invalid') {
    return current;
  }
  if (result.state !== 'unknown') {
    statusCache.set(token, result);
  }
  return result;
}

async function probeRelayTokenStatus(
  token: string,
  fetchImpl: typeof fetch,
): Promise<RelayTokenStatus> {
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
    return { state: 'valid', tier: parsed.data.userStatus.tier };
  } catch {
    return { state: 'unknown' };
  }
}
