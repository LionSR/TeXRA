import { storeCredential } from '@common/secrets/storeCredential';
import {
  API_PROVIDERS,
  apiKeySecretName,
  invalidateApiKeyCache,
  loadApiKeyStatusMap,
  type ApiKeyStatus,
  type ApiProvider,
} from '@model/apiProviders';
import type { PlatformSecrets } from '@platform/secrets';
import { providerDisplayName } from '@shared/constants/providers';

export function loadProviderApiKeyStatuses(
  secrets: PlatformSecrets,
): Promise<Record<ApiProvider, ApiKeyStatus>> {
  return loadApiKeyStatusMap(secrets, API_PROVIDERS);
}

/** Persist a provider key without exposing it outside the credential store. */
export async function saveProviderApiKey(
  secrets: PlatformSecrets,
  provider: ApiProvider,
  key: string,
): Promise<void> {
  // Write before invalidating so a concurrent lookup cannot restore a stale
  // missing-key cache entry after the credential has been saved.
  await storeCredential(secrets, {
    secretName: apiKeySecretName(provider),
    value: key,
    kind: 'provider',
    label: providerDisplayName(provider),
  });
  invalidateApiKeyCache();
}
