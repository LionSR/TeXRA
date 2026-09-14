/**
 * API provider constants and key resolution utilities.
 *
 * Shared between SecretManager (VS Code), modelRoutes (agent runtime),
 * and computeModelOptions (model). Platform-agnostic.
 */
import { Data, Effect, Redacted } from 'effect';

import type { PlatformSecrets, SecretsFailed } from '@platform/secrets';
import { API_KEY_PROVIDER_IDS } from '@shared/constants/providers';
import { isNonEmptyString } from '@utils/core';

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
type CachedLookup = Effect.Effect<ResolvedApiKey, SecretsFailed>;
let lookupCaches = new WeakMap<
  PlatformSecrets,
  Map<ApiProvider, CachedLookup>
>();

export function invalidateApiKeyCache(): void {
  lookupCaches = new WeakMap();
}

/** No API key is configured for a provider that requires one. */
export class ApiKeyMissing extends Data.TaggedError('ApiKeyMissing')<{
  readonly provider: ApiProvider;
  readonly message: string;
}> {}

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
const resolveApiKeyUncached = Effect.fn('apiProviders.resolveApiKeyUncached')(
  function* (
    secrets: PlatformSecrets,
    provider: ApiProvider,
  ): Generator<
    Effect.Effect<string | undefined, SecretsFailed>,
    ResolvedApiKey
  > {
    const stored = yield* secrets.get(apiKeySecretName(provider));
    if (isNonEmptyString(stored)) {
      return { value: redactedKey(stored, provider), origin: 'secret' };
    }
    const envValue = secrets.getEnv(apiKeyEnvName(provider));
    if (isNonEmptyString(envValue)) {
      return { value: redactedKey(envValue, provider), origin: 'env' };
    }
    return { value: undefined, origin: 'none' };
  },
);

/**
 * Cached secret → env lookup, scoped to the supplied credential store. One
 * TTL-cached effect per store and provider: concurrent readers share the one
 * in-flight lookup and a settled one is reused until the TTL expires.
 * Invalidation replaces the store map, so a lookup already in flight can only
 * populate its retired cache and cannot restore a deleted key.
 */
const resolveApiKey = Effect.fn('apiProviders.resolveApiKey')(function* (
  secrets: PlatformSecrets,
  provider: ApiProvider,
) {
  const cache =
    lookupCaches.get(secrets) ?? new Map<ApiProvider, CachedLookup>();
  lookupCaches.set(secrets, cache);
  const cached = cache.get(provider);
  if (cached) return yield* cached;
  const lookup = yield* Effect.cachedWithTTL(
    resolveApiKeyUncached(secrets, provider),
    LOOKUP_CACHE_TTL_MS,
  );
  cache.set(provider, lookup);
  return yield* lookup;
});

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
export const lookupApiKey = Effect.fn('apiProviders.lookupApiKey')(function* (
  secrets: PlatformSecrets,
  provider: ApiProvider,
) {
  return (yield* resolveApiKey(secrets, provider)).value;
});

/** Origin of the resolved key (`secret` / `env` / `none`). See trio doc above. */
export const lookupApiKeyOrigin = Effect.fn('apiProviders.lookupApiKeyOrigin')(
  function* (secrets: PlatformSecrets, provider: ApiProvider) {
    return (yield* resolveApiKey(secrets, provider)).origin;
  },
);

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
  return Effect.map(
    Effect.all(
      providers.map((provider) => lookupApiKeyOrigin(secrets, provider)),
      { concurrency: 'unbounded' },
    ),
    (origins) =>
      Object.fromEntries(
        providers.map((provider, index) => [
          provider,
          STATUS_BY_ORIGIN[origins[index] ?? 'none'],
        ]),
      ) as Record<Provider, ApiKeyStatus>,
  );
}

/**
 * Return provider IDs that have a configured API key (secret or env).
 * Shared by the CLI status surfaces so the provider-key scan lives in one place.
 */
export const configuredApiKeyProviders = Effect.fn(
  'apiProviders.configuredApiKeyProviders',
)(function* (secrets: PlatformSecrets) {
  const origins = yield* Effect.all(
    API_PROVIDERS.map((provider) => lookupApiKeyOrigin(secrets, provider)),
    { concurrency: 'unbounded' },
  );
  return API_PROVIDERS.filter((_, index) => origins[index] !== 'none');
});

/** Get an API key, failing with {@link ApiKeyMissing} if not found. */
export const getApiKey = Effect.fn('apiProviders.getApiKey')(function* (
  secrets: PlatformSecrets,
  provider: ApiProvider,
) {
  const key = yield* lookupApiKey(secrets, provider);
  if (!key) {
    return yield* Effect.fail(
      new ApiKeyMissing({
        provider,
        message: `No API key found for ${provider}. Set the ${apiKeyEnvName(provider)} environment variable, or configure your ${provider} API key.`,
      }),
    );
  }
  return key;
});

/**
 * Check whether a usable API key is resolved for a provider (secret storage,
 * then environment, both already trimmed and blank-filtered by
 * {@link resolveApiKeyUncached}). This is the single cached existence check;
 * `apiKeyExistsUncached` below is the uncached variant for call sites that
 * must bypass the process-wide provider cache.
 */
export const hasUsableApiKey = Effect.fn('apiProviders.hasUsableApiKey')(
  function* (secrets: PlatformSecrets, provider: ApiProvider) {
    return (yield* lookupApiKey(secrets, provider)) !== undefined;
  },
);

/**
 * Read the key without the process-wide cache. Change detection needs this:
 * the cached lookup's TTL would hand back the previous key for seconds after
 * the user set a new one.
 */
export const lookupApiKeyUncached = Effect.fn(
  'apiProviders.lookupApiKeyUncached',
)(function* (secrets: PlatformSecrets, provider: ApiProvider) {
  return (yield* resolveApiKeyUncached(secrets, provider)).value;
});

/** Check if an API key exists without using the process-wide provider cache. */
export const apiKeyExistsUncached = Effect.fn(
  'apiProviders.apiKeyExistsUncached',
)(function* (secrets: PlatformSecrets, provider: ApiProvider) {
  return (yield* resolveApiKeyUncached(secrets, provider)).value !== undefined;
});
