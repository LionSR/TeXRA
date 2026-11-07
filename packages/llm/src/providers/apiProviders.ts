/**
 * The direct API-key providers and the lookup of their keys over the
 * caller's {@link CredentialStore}: the stored key, then the provider's
 * conventional environment variable.
 */
import { Effect, Redacted } from 'effect';

import {
  type CredentialOrigin,
  type CredentialStore,
  resolveCredential,
  type SecretsFailed,
} from './credentials.js';
import { apiKeyEnvName } from './providers.js';
import {
  API_KEY_PROVIDER_IDS,
  type ApiKeyProviderId,
} from './providerPlugins.js';

/** Runtime-checked narrowing for provider strings. */
export function isApiProvider(provider: string): provider is ApiKeyProviderId {
  return API_KEY_PROVIDER_IDS.some((id) => id === provider);
}

/** Secret storage key for a provider's API key. */
export function apiKeySecretName(provider: ApiKeyProviderId): string {
  return `apiKey.${provider}`;
}

/**
 * What a secret-store entry is, the inverse of {@link apiKeySecretName}: the
 * provider whose API key it holds, `'unknown'` for an API-key entry of no
 * provider this build knows, or `undefined` for every other entry (OAuth
 * tokens, the GitHub token).
 */
export function apiKeyEntry(
  key: string,
): ApiKeyProviderId | 'unknown' | undefined {
  if (!key.startsWith('apiKey.')) return undefined;
  const provider = key.slice('apiKey.'.length);
  return isApiProvider(provider) ? provider : 'unknown';
}

/** A provider's key, sealed, and its origin. */
export interface ResolvedApiKey {
  /**
   * Held as `Redacted` from the store outward, so every caller carries a value
   * that renders as `<redacted:provider>` if it ever reaches a log, a trace,
   * or `JSON.stringify`. Only the call that hands the credential to a
   * provider client unwraps it.
   */
  value: Redacted.Redacted<string> | undefined;
  origin: CredentialOrigin;
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
 * The provider's key and where it came from, through the one credential
 * ladder: the secret store (the authority; no copy of it is cached here),
 * then the provider's conventional environment variable. A program: a caller
 * yields it and matches {@link SecretsFailed} instead of catching `unknown`
 * from a rejected read.
 */
export function apiKey(
  credentials: CredentialStore,
  provider: ApiKeyProviderId,
): Effect.Effect<ResolvedApiKey, SecretsFailed> {
  return Effect.map(
    resolveCredential(credentials, apiKeySecretName(provider), [
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

/** Where every API-key provider's key comes from. */
export function apiKeyOrigins(
  credentials: CredentialStore,
): Effect.Effect<Record<ApiKeyProviderId, CredentialOrigin>, SecretsFailed> {
  return Effect.forEach(
    API_KEY_PROVIDER_IDS,
    (provider) =>
      Effect.map(
        apiKey(credentials, provider),
        ({ origin }) => [provider, origin] as const,
      ),
    { concurrency: 'unbounded' },
  ).pipe(
    Effect.map(
      // `entries` holds one pair per id in API_KEY_PROVIDER_IDS, which lists
      // every ApiKeyProviderId, so the record is total.
      (entries) =>
        // cast: total over ApiKeyProviderId, per the note above.
        Object.fromEntries(entries) as Record<
          ApiKeyProviderId,
          CredentialOrigin
        >,
    ),
  );
}

/**
 * Check whether a usable API key is resolved for a provider (secret storage,
 * then environment, both trimmed and blank-filtered by `resolveCredential`).
 * This is the existence check every host shares.
 */
export function hasUsableApiKey(
  credentials: CredentialStore,
  provider: ApiKeyProviderId,
): Effect.Effect<boolean, SecretsFailed> {
  return Effect.map(
    apiKey(credentials, provider),
    (resolved) => resolved.value !== undefined,
  );
}
