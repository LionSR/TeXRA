import { Effect } from 'effect';

import { storeCredential } from '@common/secrets/storeCredential';
import {
  API_PROVIDERS,
  apiKeySecretName,
  invalidateApiKeyCache,
  loadApiKeyStatusMap,
  type ApiKeyStatus,
  type ApiProvider,
} from '@model/apiProviders';
import type { PlatformSecrets, SecretsFailed } from '@platform/secrets';
import { providerDisplayName } from '@shared/constants/providers';

export function loadProviderApiKeyStatuses(
  secrets: PlatformSecrets,
): Promise<Record<ApiProvider, ApiKeyStatus>> {
  return loadApiKeyStatusMap(secrets, API_PROVIDERS);
}

/**
 * Persist a provider key without exposing it outside the credential store.
 * A program, like the store it writes to; the terminal surface that calls it
 * settles it on the process runtime.
 */
export function saveProviderApiKey(
  secrets: PlatformSecrets,
  provider: ApiProvider,
  key: string,
): Effect.Effect<void, Error | SecretsFailed> {
  // The cache drop is a finalizer of the write, not a step after it. A write
  // the store committed under its uninterruptible region still exits as
  // interrupted when the caller was cancelled during it, so a `tap` — or an
  // exit-inspecting finalizer — would be skipped over a key that is now on
  // disk, leaving it invisible behind a stale missing-key entry for the cache
  // TTL. The finalizer runs on every exit instead: dropping the cache when
  // nothing was written costs one uncached lookup, while missing the drop
  // after a commit costs a credential the process cannot see. Ordering is
  // unchanged — the write settles first, so a concurrent lookup cannot
  // repopulate the stale entry.
  return Effect.ensuring(
    storeCredential(secrets, {
      secretName: apiKeySecretName(provider),
      value: key,
      kind: 'provider',
      label: providerDisplayName(provider),
    }),
    Effect.sync(invalidateApiKeyCache),
  );
}
