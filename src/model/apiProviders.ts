/**
 * API provider constants and key resolution utilities.
 *
 * Shared between SecretManager (VS Code), modelRoutes (agent runtime),
 * and computeModelOptions (model). Platform-agnostic.
 */
import { Data, Effect, Redacted } from 'effect';

import {
  type CredentialOrigin,
  type PlatformSecrets,
  resolveCredential,
  type SecretsFailed,
} from '@platform/secrets';
import {
  API_KEY_PROVIDER_IDS,
  apiKeyEnvName,
} from '@shared/constants/providers';

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

/** Where a resolved API key came from. */
export type ApiKeyOrigin = CredentialOrigin;

/** UI-safe provider key status derived from a resolved API key origin. */
export type ApiKeyStatus = 'set' | 'env' | 'not-set';

interface ResolvedApiKey {
  /**
   * Held as `Redacted` from the store outward, so every caller carries a value
   * that renders as `<redacted:provider>` if it ever reaches a log, a trace,
   * or `JSON.stringify`. Only the call that hands the credential to a
   * provider client unwraps it.
   */
  value: Redacted.Redacted<string> | undefined;
  origin: ApiKeyOrigin;
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

/**
 * Read the provider's key through the one credential ladder: the secret store
 * (the authority; no copy of it is cached here), then the provider's
 * conventional environment variable.
 */
function resolveApiKey(
  secrets: PlatformSecrets,
  provider: ApiProvider,
): Effect.Effect<ResolvedApiKey, SecretsFailed> {
  return Effect.map(
    resolveCredential(secrets, apiKeySecretName(provider), [
      apiKeyEnvName(provider),
    ]),
    ({ value, origin }) => ({
      value:
        value === undefined
          ? undefined
          : Redacted.make(value, { label: provider }),
      origin,
    }),
  );
}

/**
 * API key lookup trio. All three share the same {@link resolveApiKey} pass
 * over secret storage then the env var:
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

/** Resolve key statuses for providers from their resolved key origins. */
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
 * then environment, both trimmed and blank-filtered by `resolveCredential`).
 * This is the existence check every host shares.
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
