/**
 * API provider constants and key resolution utilities.
 *
 * Shared between SecretManager (VS Code), modelRoutes (agent runtime),
 * and computeModelOptions (model). Platform-agnostic.
 */
import { Data, Deferred, Effect, Redacted } from 'effect';
import { LRUCache } from 'lru-cache';

import type { PlatformSecrets, SecretsFailed } from '@platform/secrets';
import { findModelProviderPlugin } from '@shared/constants/modelProviderPlugins';
import { API_KEY_PROVIDER_IDS } from '@shared/constants/providers';
import { isNonEmptyString } from '@utils/text/stringUtils';

export const API_PROVIDERS = API_KEY_PROVIDER_IDS;

export type ApiProvider = (typeof API_PROVIDERS)[number];

/** Runtime-checked narrowing for provider strings. */
export function isApiProvider(provider: string): provider is ApiProvider {
  return (API_PROVIDERS as readonly string[]).includes(provider);
}

/** Secret storage key for a provider's API key. */
export function apiKeySecretName(provider: ApiProvider): string {
  return `apiKey.${provider}`;
}

/**
 * The provider whose API key a secret-store entry holds, or `undefined` for
 * every other entry (OAuth tokens, the GitHub token, sign-in nonces). The
 * inverse of {@link apiKeySecretName}, for subscribers of the store's
 * `credentialChanged` signal.
 */
export function apiProviderOfSecretName(key: string): ApiProvider | undefined {
  const provider = key.startsWith('apiKey.') ? key.slice('apiKey.'.length) : '';
  return isApiProvider(provider) ? provider : undefined;
}

/** Environment variable name for a provider's API key. */
export function apiKeyEnvName(provider: ApiProvider): string {
  return (
    findModelProviderPlugin(provider)?.apiKeyEnvName ??
    `${provider.toUpperCase()}_API_KEY`
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
  readonly pending: Map<
    ApiProvider,
    Deferred.Deferred<ResolvedApiKey, SecretsFailed>
  >;
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
function resolveApiKeyUncached(
  secrets: PlatformSecrets,
  provider: ApiProvider,
): Effect.Effect<ResolvedApiKey, SecretsFailed> {
  return Effect.map(secrets.get(apiKeySecretName(provider)), (stored) => {
    if (isNonEmptyString(stored)) {
      return { value: redactedKey(stored, provider), origin: 'secret' };
    }
    const envValue = secrets.getEnv(apiKeyEnvName(provider));
    if (isNonEmptyString(envValue)) {
      return { value: redactedKey(envValue, provider), origin: 'env' };
    }
    return { value: undefined, origin: 'none' };
  });
}

/** The cache for one credential store, created on first use. */
function lookupCacheFor(secrets: PlatformSecrets): ApiKeyLookupCache {
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
  return cache;
}

/**
 * Cached secret → env lookup, scoped to the supplied credential store, with
 * the two properties the suite pins: one store read per provider per store,
 * and a rejected read memoized nowhere, so the next caller retries instead of
 * replaying a failure. Invalidation replaces the store map, so a read already
 * in flight can only populate its retired cache and cannot restore a deleted
 * key in subsequent lookups.
 *
 * The read runs on a detached fiber and every caller waits on the same
 * `Deferred`, so one caller's cancellation cancels only its own wait — what
 * the shared promise this replaced did by construction. The claim and the
 * fork run under one uninterruptible mask: an interrupt landing between
 * registering the deferred and starting the fiber that settles it would
 * otherwise leave every later caller waiting on an entry nothing completes.
 * Only the waits themselves are interruptible.
 */
function resolveApiKey(
  secrets: PlatformSecrets,
  provider: ApiProvider,
): Effect.Effect<ResolvedApiKey, SecretsFailed> {
  return Effect.uninterruptibleMask((restore) =>
    Effect.suspend(() => {
      const cache = lookupCacheFor(secrets);
      const cached = cache.resolved.get(provider);
      if (cached !== undefined) return Effect.succeed(cached);
      const inFlight = cache.pending.get(provider);
      if (inFlight !== undefined) return restore(Deferred.await(inFlight));

      const request = Deferred.makeUnsafe<ResolvedApiKey, SecretsFailed>();
      cache.pending.set(provider, request);
      return Effect.flatMap(
        Effect.forkDetach(
          resolveApiKeyUncached(secrets, provider).pipe(
            Effect.tap((resolved) =>
              Effect.sync(() => {
                cache.resolved.set(provider, resolved);
              }),
            ),
            Effect.onExit((exit) =>
              Effect.sync(() => {
                if (cache.pending.get(provider) === request) {
                  cache.pending.delete(provider);
                }
                Deferred.doneUnsafe(request, exit);
              }),
            ),
          ),
        ),
        () => restore(Deferred.await(request)),
      );
    }),
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
 *
 * All three are programs: a caller yields one and matches
 * {@link SecretsFailed} instead of catching `unknown` from a rejected read.
 */
export function lookupApiKey(
  secrets: PlatformSecrets,
  provider: ApiProvider,
): Effect.Effect<Redacted.Redacted<string> | undefined, SecretsFailed> {
  return Effect.map(
    resolveApiKey(secrets, provider),
    (resolved) => resolved.value,
  );
}

/** Origin of the resolved key (`secret` / `env` / `none`). See trio doc above. */
export function lookupApiKeyOrigin(
  secrets: PlatformSecrets,
  provider: ApiProvider,
): Effect.Effect<ApiKeyOrigin, SecretsFailed> {
  return Effect.map(
    resolveApiKey(secrets, provider),
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

/** No key is configured for the provider, in secret storage or the env. */
class ApiKeyMissing extends Data.TaggedError('ApiKeyMissing')<{
  readonly provider: ApiProvider;
  readonly message: string;
}> {}

/** Get an API key, failing if none is configured. See trio doc above. */
export function getApiKey(
  secrets: PlatformSecrets,
  provider: ApiProvider,
): Effect.Effect<Redacted.Redacted<string>, SecretsFailed | ApiKeyMissing> {
  return Effect.flatMap(resolveApiKey(secrets, provider), ({ value: key }) =>
    key === undefined
      ? Effect.fail(
          new ApiKeyMissing({
            provider,
            message: `No API key found for ${provider}. Set the ${apiKeyEnvName(provider)} environment variable, or configure your ${provider} API key.`,
          }),
        )
      : Effect.succeed(key),
  );
}

/**
 * Check whether a usable API key is resolved for a provider (secret storage,
 * then environment, both already trimmed and blank-filtered by
 * {@link resolveApiKeyUncached}). This is the existence check every host
 * shares; a call site that must bypass the process-wide provider cache reads
 * {@link lookupApiKeyUncached} instead.
 */
export function hasUsableApiKey(
  secrets: PlatformSecrets,
  provider: ApiProvider,
): Effect.Effect<boolean, SecretsFailed> {
  return Effect.map(
    resolveApiKey(secrets, provider),
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
    resolveApiKeyUncached(secrets, provider),
    (resolved) => resolved.value,
  );
}
