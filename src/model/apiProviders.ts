/**
 * API provider constants and key resolution utilities.
 *
 * Shared between SecretManager (VS Code), ModelHandler (agent core),
 * and computeModelOptions (model). Platform-agnostic.
 */
import { LRUCache } from 'lru-cache';

import type { PlatformSecrets } from '@platform/secrets';
import { API_KEY_PROVIDER_IDS } from '@shared/constants/providers';
import { coalesceAsync, isNonEmptyString } from '@utils/core';

export const API_PROVIDERS = API_KEY_PROVIDER_IDS;

export type ApiProvider = (typeof API_PROVIDERS)[number];

const API_KEY_ENV_NAME_OVERRIDES: Partial<Record<ApiProvider, string>> = {
  kimiCode: 'KIMI_CODE_API_KEY',
};

/** Runtime-checked narrowing for provider strings. */
export function isApiProvider(provider: string): provider is ApiProvider {
  return (API_PROVIDERS as readonly string[]).includes(provider);
}

/** Secret storage key for a provider's API key. */
export function apiKeySecretName(provider: ApiProvider): string {
  return `apiKey.${provider}`;
}

/** Environment variable name for a provider's API key. */
export function apiKeyEnvName(provider: ApiProvider): string {
  return (
    API_KEY_ENV_NAME_OVERRIDES[provider] ?? `${provider.toUpperCase()}_API_KEY`
  );
}

/** Where a resolved API key came from. */
export type ApiKeyOrigin = 'secret' | 'env' | 'none';

/** UI-safe provider key status derived from a resolved API key origin. */
export type ApiKeyStatus = 'set' | 'env' | 'not-set';

interface ResolvedApiKey {
  value: string | undefined;
  origin: ApiKeyOrigin;
}

// Short-lived cache to dedupe concurrent secret scans across paths
// (e.g. computeModelOptions + settings-view profile refresh after a key
// change). Invalidate explicitly when a key is set or removed.
const LOOKUP_CACHE_TTL_MS = 5_000;
const lookupCache = new LRUCache<ApiProvider, ResolvedApiKey>({
  max: API_PROVIDERS.length,
  ttl: LOOKUP_CACHE_TTL_MS,
});
const lookupPending = new Map<ApiProvider, Promise<ResolvedApiKey>>();

export function invalidateApiKeyCache(): void {
  lookupCache.clear();
  lookupPending.clear();
}

/** Read the key straight from secret storage then the environment, no caching. */
async function resolveApiKeyUncached(
  secrets: PlatformSecrets,
  provider: ApiProvider,
): Promise<ResolvedApiKey> {
  const stored = await secrets.get(apiKeySecretName(provider));
  if (isNonEmptyString(stored)) {
    return { value: stored.trim(), origin: 'secret' };
  }
  const envValue = secrets.getEnv(apiKeyEnvName(provider));
  if (isNonEmptyString(envValue)) {
    return { value: envValue.trim(), origin: 'env' };
  }
  return { value: undefined, origin: 'none' };
}

/**
 * Cached secret → env lookup. Invalidation clears the in-flight map too, so a
 * read that was already awaiting refuses to cache its now-stale result rather
 * than re-poisoning the cache after the user deleted the key.
 */
function resolveApiKey(
  secrets: PlatformSecrets,
  provider: ApiProvider,
): Promise<ResolvedApiKey> {
  return coalesceAsync<ApiProvider, ResolvedApiKey>(
    lookupCache,
    lookupPending,
    provider,
    () => resolveApiKeyUncached(secrets, provider),
  );
}

/**
 * API key lookup trio. All three share the same TTL-cached
 * {@link resolveApiKey} pass over secret storage → env var:
 *
 * - {@link lookupApiKey} — value, or `undefined` if absent (most callers)
 * - {@link lookupApiKeyOrigin} — origin tag for UI status reporting
 * - {@link getApiKey} — value, or throws (call from code that requires a key)
 *
 * They are kept as distinct entry points so call sites read self-evidently
 * (no `{ throwIfMissing: true }` flag at every model handler).
 */
export async function lookupApiKey(
  secrets: PlatformSecrets,
  provider: ApiProvider,
): Promise<string | undefined> {
  return (await resolveApiKey(secrets, provider)).value;
}

/** Origin of the resolved key (`secret` / `env` / `none`). See trio doc above. */
export async function lookupApiKeyOrigin(
  secrets: PlatformSecrets,
  provider: ApiProvider,
): Promise<ApiKeyOrigin> {
  return (await resolveApiKey(secrets, provider)).origin;
}

const STATUS_BY_ORIGIN: Record<ApiKeyOrigin, ApiKeyStatus> = {
  secret: 'set',
  env: 'env',
  none: 'not-set',
};

/**
 * Resolve key statuses for providers from the canonical API-key origin cache.
 */
export async function loadApiKeyStatusMap<const Provider extends ApiProvider>(
  secrets: PlatformSecrets,
  providers: readonly Provider[],
): Promise<Record<Provider, ApiKeyStatus>> {
  const entries = await Promise.all(
    providers.map(async (provider) => [
      provider,
      STATUS_BY_ORIGIN[await lookupApiKeyOrigin(secrets, provider)],
    ]),
  );
  return Object.fromEntries(entries) as Record<Provider, ApiKeyStatus>;
}

/**
 * Return provider IDs that have a configured API key (secret or env).
 * Shared by the CLI status surfaces so the provider-key scan lives in one place.
 */
export async function configuredApiKeyProviders(
  secrets: PlatformSecrets,
): Promise<ApiProvider[]> {
  const origins = await Promise.all(
    API_PROVIDERS.map((provider) => lookupApiKeyOrigin(secrets, provider)),
  );
  return API_PROVIDERS.filter((_, index) => origins[index] !== 'none');
}

/** Get an API key, throwing if not found. See trio doc above. */
export async function getApiKey(
  secrets: PlatformSecrets,
  provider: ApiProvider,
): Promise<string> {
  const key = await lookupApiKey(secrets, provider);
  if (!key) {
    throw new Error(
      `No API key found for ${provider}. Set the ${apiKeyEnvName(provider)} environment variable, or configure your ${provider} API key.`,
    );
  }
  return key;
}

/**
 * Check whether a usable API key is resolved for a provider (secret storage,
 * then environment, both already trimmed and blank-filtered by
 * {@link resolveApiKeyUncached}). This is the single cached existence check;
 * `apiKeyExistsUncached` below is the uncached variant for call sites that
 * must bypass the process-wide provider cache.
 */
export async function hasUsableApiKey(
  secrets: PlatformSecrets,
  provider: ApiProvider,
): Promise<boolean> {
  return isNonEmptyString(await lookupApiKey(secrets, provider));
}

/** Check if an API key exists without using the process-wide provider cache. */
export async function apiKeyExistsUncached(
  secrets: PlatformSecrets,
  provider: ApiProvider,
): Promise<boolean> {
  return (await resolveApiKeyUncached(secrets, provider)).value !== undefined;
}
