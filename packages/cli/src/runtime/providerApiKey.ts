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
    emptyMessage: 'API key is empty.',
    placeholderMessage: `This looks like a placeholder rather than a ${provider} API key. Enter the key issued by the provider.`,
  });
  invalidateApiKeyCache();
}
