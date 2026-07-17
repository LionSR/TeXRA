import { platform } from '@platform/platform';
import {
  apiKeySecretName,
  invalidateApiKeyCache,
  type ApiProvider,
} from '@model/apiProviders';

import { setCliApiMode } from './apiAccessMode';

/** Persist a provider key and make personal API-key access active. */
export async function saveProviderApiKey(
  provider: ApiProvider,
  key: string,
): Promise<void> {
  const trimmed = key.trim();
  if (!trimmed) throw new Error('API key is empty.');

  // Write before invalidating so a concurrent lookup cannot restore a stale
  // missing-key cache entry after the credential has been saved.
  await platform().secrets.set(apiKeySecretName(provider), trimmed);
  invalidateApiKeyCache();
  await setCliApiMode('personal');
}
