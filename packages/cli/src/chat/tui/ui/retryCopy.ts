import type { ApiProvider } from '@model/apiProviders';
import { PROVIDER_DISPLAY_NAMES } from '@shared/constants/providers';

export function missingApiKeyRetryMessage(provider?: ApiProvider): string {
  if (!provider) {
    return 'The failed API provider could not be identified. Press n to give up, then use `/key` to verify the correct provider key.';
  }
  return `No ${PROVIDER_DISPLAY_NAMES[provider] ?? provider} API key is configured. Press n to give up, then use \`/key\` to add one.`;
}
