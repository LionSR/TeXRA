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
  // Write before invalidating so a concurrent lookup cannot restore a stale
  // missing-key cache entry after the credential has been saved.
  return Effect.tap(
    storeCredential(secrets, {
      secretName: apiKeySecretName(provider),
      value: key,
      kind: 'provider',
      label: providerDisplayName(provider),
    }),
    () => Effect.sync(invalidateApiKeyCache),
  );
}
