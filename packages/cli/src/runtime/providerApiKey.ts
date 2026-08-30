import { storeCredential } from '@common/secrets/storeCredential';
import {
  API_PROVIDERS,
  apiKeySecretName,
  invalidateApiKeyCache,
  loadApiKeyStatusMap,
  type ApiKeyStatus,
  type ApiProvider,
} from '@model/apiProviders';
import { platform } from '@platform/platform';
import { providerDisplayName } from '@shared/constants/providers';

export function loadProviderApiKeyStatuses(): Promise<
  Record<ApiProvider, ApiKeyStatus>
> {
  return loadApiKeyStatusMap(platform().secrets, API_PROVIDERS);
}

/** Persist a provider key without exposing it outside the credential store. */
export async function saveProviderApiKey(
  provider: ApiProvider,
  key: string,
): Promise<void> {
  // Write before invalidating so a concurrent lookup cannot restore a stale
  // missing-key cache entry after the credential has been saved.
  await storeCredential(platform().secrets, {
    secretName: apiKeySecretName(provider),
    value: key,
    kind: 'provider',
    label: providerDisplayName(provider),
  });
  invalidateApiKeyCache();
}
