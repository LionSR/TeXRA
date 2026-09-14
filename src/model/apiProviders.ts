/**
 * API provider constants and key resolution utilities.
 *
 * Shared between SecretManager (VS Code), modelRoutes (agent runtime),
 * and computeModelOptions (model). Platform-agnostic.
 */
import { Effect, Redacted } from 'effect';
import { LRUCache } from 'lru-cache';

import { SecretsFailed, type PlatformSecrets } from '@platform/secrets';
import { API_KEY_PROVIDER_IDS } from '@shared/constants/providers';
import { coalesceAsync, isNonEmptyString } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

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
  /**
   * Held as `Redacted` from the store outward, so the short-lived cache below
   * and every caller carry a value that renders as `<redacted:provider>` if it
   * ever reaches a log, a trace, or `JSON.stringify`. Only the call that hands
   * the credential to a provider client unwraps it.
   */
  value: Redacted.Redacted<string> | undefined;
  origin: ApiKeyOrigin;
}

// Short-lived per-store caches deduplicate concurrent secret scans without
// sharing credentials between independently supplied stores. Invalidation drops
// every store's cache; already-running reads retain only the retired cache.
const LOOKUP_CACHE_TTL_MS = 5_000;
interface ApiKeyLookupCache {
  readonly resolved: LRUCache<ApiProvider, ResolvedApiKey>;
  readonly pending: Map<ApiProvider, Promise<ResolvedApiKey>>;
}
let lookupCaches = new WeakMap<PlatformSecrets, ApiKeyLookupCache>();

export function invalidateApiKeyCache(): void {
  lookupCaches = new WeakMap();
}

/**
 * Unwrap a sealed key at the one point it is handed to a foreign runtime: a
 * provider SDK, a subprocess environment, a usage client. Every other caller
 * keeps the `Redacted` value, which renders as `<redacted:provider>` in a log,
 * a trace, or `JSON.stringify`. Named rather than inlined so the places that
 * expose a credential are greppable, and so a caller need not import `effect`
 * to hand a key onward.
 */
export function exposeApiKey(key: Redacted.Redacted<string>): string {
  return Redacted.value(key);
}

/** Trim a raw key and seal it under a label naming only its provider. */
function redactedKey(
  raw: string,
  provider: ApiProvider,
): Redacted.Redacted<string> {
  return Redacted.make(raw.trim(), { label: provider });
}

/** Read the key straight from secret storage then the environment, no caching. */
async function resolveApiKeyUncached(
  secrets: PlatformSecrets,
  provider: ApiProvider,
): Promise<ResolvedApiKey> {
  const stored = await secrets.get(apiKeySecretName(provider));
  if (isNonEmptyString(stored)) {
    return { value: redactedKey(stored, provider), origin: 'secret' };
  }
  const envValue = secrets.getEnv(apiKeyEnvName(provider));
  if (isNonEmptyString(envValue)) {
    return { value: redactedKey(envValue, provider), origin: 'env' };
  }
  return { value: undefined, origin: 'none' };
}

/**
 * Cached secret → env lookup, scoped to the supplied credential store.
 * Invalidation replaces the store map, so a pending read can only populate
 * its retired cache and cannot restore a deleted key in subsequent lookups.
 */
function resolveApiKey(
  secrets: PlatformSecrets,
  provider: ApiProvider,
): Promise<ResolvedApiKey> {
  let cache = lookupCaches.get(secrets);
  if (!cache) {
    cache = {
      resolved: new LRUCache({
        max: API_PROVIDERS.length,
        ttl: LOOKUP_CACHE_TTL_MS,
      }),
      pending: new Map(),
    };
    lookupCaches.set(secrets, cache);
  }
  return coalesceAsync<ApiProvider, ResolvedApiKey>(
    cache.resolved,
    cache.pending,
    provider,
    () => resolveApiKeyUncached(secrets, provider),
  );
}

/**
 * The module's one bridge from the Promise-shaped `PlatformSecrets.get` to a
 * typed failure channel: a store that rejects reaches the caller as the
 * port's own {@link SecretsFailed} against the member this module called,
 * exactly as it will once `get` itself is an `Effect` (#12424, C4). The cache
 * above stays Promise-shaped for that reason — it is the shared shape of the
 * read it deduplicates, not a second system — and it keeps its two pinned
 * properties: one store read per provider per store, and a rejected read
 * memoized nowhere, so the next caller retries instead of replaying a failure.
 */
function storeRead(
  provider: ApiProvider,
  read: () => Promise<ResolvedApiKey>,
): Effect.Effect<ResolvedApiKey, SecretsFailed> {
  return Effect.tryPromise({
    try: read,
    catch: (cause) =>
      new SecretsFailed({
        reason: 'io',
        operation: 'get',
        key: apiKeySecretName(provider),
        message: `Could not read the ${provider} API key from the credential store: ${toErrorMessage(cause)}`,
        cause,
      }),
  });
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
 *
 * {@link lookupApiKeyOrigin} is a program: a caller inside an `Effect` yields
 * it and matches {@link SecretsFailed} instead of bridging a promise and
 * catching `unknown`. The two reads of the key *value* are still promises,
 * because each one's remaining consumer is a promise pipeline this module
 * cannot move on its own — `resolveRouteCredential` for {@link getApiKey}
 * (awaited inside the model binding's own host frame) and
 * `SubscriptionUsageService`'s coalesced snapshot fetch for
 * {@link lookupApiKey} (a `coalesceAsync` over Promise-shaped provider
 * transports, in a zone where an `Effect.run*` is forbidden). Both move with
 * the port itself (#12424, C4), which is when their pipelines move too.
 */
export async function lookupApiKey(
  secrets: PlatformSecrets,
  provider: ApiProvider,
): Promise<Redacted.Redacted<string> | undefined> {
  return (await resolveApiKey(secrets, provider)).value;
}

/** Origin of the resolved key (`secret` / `env` / `none`). See trio doc above. */
export function lookupApiKeyOrigin(
  secrets: PlatformSecrets,
  provider: ApiProvider,
): Effect.Effect<ApiKeyOrigin, SecretsFailed> {
  return Effect.map(
    storeRead(provider, () => resolveApiKey(secrets, provider)),
    (resolved) => resolved.origin,
  );
}

const STATUS_BY_ORIGIN: Record<ApiKeyOrigin, ApiKeyStatus> = {
  secret: 'set',
  env: 'env',
  none: 'not-set',
};

/**
 * Resolve key statuses for providers from the canonical API-key origin cache.
 */
export function loadApiKeyStatusMap<const Provider extends ApiProvider>(
  secrets: PlatformSecrets,
  providers: readonly Provider[],
): Effect.Effect<Record<Provider, ApiKeyStatus>, SecretsFailed> {
  return Effect.forEach(
    providers,
    (provider) =>
      Effect.map(
        lookupApiKeyOrigin(secrets, provider),
        (origin) => [provider, STATUS_BY_ORIGIN[origin]] as const,
      ),
    { concurrency: 'unbounded' },
  ).pipe(
    Effect.map(
      (entries) =>
        Object.fromEntries(entries) as Record<Provider, ApiKeyStatus>,
    ),
  );
}

/**
 * Return provider IDs that have a configured API key (secret or env).
 * Shared by the CLI status surfaces so the provider-key scan lives in one place.
 */
export function configuredApiKeyProviders(
  secrets: PlatformSecrets,
): Effect.Effect<ApiProvider[], SecretsFailed> {
  return Effect.forEach(
    API_PROVIDERS,
    (provider) => lookupApiKeyOrigin(secrets, provider),
    { concurrency: 'unbounded' },
  ).pipe(
    Effect.map((origins) =>
      API_PROVIDERS.filter((_, index) => origins[index] !== 'none'),
    ),
  );
}

/** Get an API key, throwing if not found. See trio doc above. */
export async function getApiKey(
  secrets: PlatformSecrets,
  provider: ApiProvider,
): Promise<Redacted.Redacted<string>> {
  const { value: key } = await resolveApiKey(secrets, provider);
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
export function hasUsableApiKey(
  secrets: PlatformSecrets,
  provider: ApiProvider,
): Effect.Effect<boolean, SecretsFailed> {
  return Effect.map(
    storeRead(provider, () => resolveApiKey(secrets, provider)),
    (resolved) => resolved.value !== undefined,
  );
}

/**
 * Read the key without the process-wide cache. Change detection needs this:
 * the cached lookup's TTL would hand back the previous key for seconds after
 * the user set a new one.
 */
export function lookupApiKeyUncached(
  secrets: PlatformSecrets,
  provider: ApiProvider,
): Effect.Effect<Redacted.Redacted<string> | undefined, SecretsFailed> {
  return Effect.map(
    storeRead(provider, () => resolveApiKeyUncached(secrets, provider)),
    (resolved) => resolved.value,
  );
}

/** Check if an API key exists without using the process-wide provider cache. */
export function apiKeyExistsUncached(
  secrets: PlatformSecrets,
  provider: ApiProvider,
): Effect.Effect<boolean, SecretsFailed> {
  return Effect.map(
    storeRead(provider, () => resolveApiKeyUncached(secrets, provider)),
    (resolved) => resolved.value !== undefined,
  );
}
