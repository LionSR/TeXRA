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

const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /^(sk-?)?(x{3,}|\*{3,}|\.{3,}|<.*>|your[- _]?(?:api[- _]?)?key)/i,
  /^(?:api[- _]?)?key[- _]?here$/i,
  /^placeholder$/i,
  /^example$/i,
];

function looksLikePlaceholder(key: string): boolean {
  return (
    key.length < 8 || PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(key))
  );
}

/** Persist a provider key without exposing it outside the credential store. */
export async function saveProviderApiKey(
  provider: ApiProvider,
  key: string,
): Promise<void> {
  const trimmed = key.trim();
  if (!trimmed) throw new Error('API key is empty.');
  if (looksLikePlaceholder(trimmed)) {
    throw new Error(
      `This looks like a placeholder rather than a ${provider} API key. Enter the key issued by the provider.`,
    );
  }

  // Write before invalidating so a concurrent lookup cannot restore a stale
  // missing-key cache entry after the credential has been saved.
  await platform().secrets.set(apiKeySecretName(provider), trimmed);
  invalidateApiKeyCache();
}
