import type { ApiProvider } from '@model/apiProviders';
import { providerDisplayName } from '@shared/constants/providers';

export function missingApiKeyRetryMessage(
  provider?: ApiProvider,
  availability: 'missing' | 'unavailable' = 'missing',
): string {
  if (!provider) {
    return 'The failed API provider could not be identified. Press n to dismiss, then use `/key` to verify the correct provider key.';
  }
  const providerName = providerDisplayName(provider);
  return availability === 'unavailable'
    ? `TeXRA could not check whether the ${providerName} API key is available. Press n to dismiss, then use \`/key\` to try again.`
    : `No ${providerName} API key is configured. Press n to dismiss, then use \`/key\` to add one.`;
}
