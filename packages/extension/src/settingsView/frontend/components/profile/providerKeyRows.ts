// Local imports - shared schemas and constants
import type { ProviderKeyStatus } from '@shared/schemas/settingsViewMessages';
import {
  API_KEY_PROVIDER_IDS,
  PROVIDER_DISPLAY_NAMES,
  PROVIDER_URLS,
} from '@shared/constants/providers';

const DEFAULT_PROVIDER_KEY_STATUSES: ProviderKeyStatus[] =
  API_KEY_PROVIDER_IDS.map((provider) => ({
    provider,
    displayName: PROVIDER_DISPLAY_NAMES[provider] ?? provider,
    status: 'not-set',
    keyUrl: PROVIDER_URLS[provider] ?? '',
    streaming: true,
    customEndpoint: '',
    supportsCustomEndpoint: false,
    vscodeSettings: [],
  }));

/**
 * Keep provider API-key controls available even before profile state arrives.
 */
export function resolveProviderKeyRows(
  providerKeyStatuses: ProviderKeyStatus[],
): ProviderKeyStatus[] {
  return providerKeyStatuses.length > 0
    ? providerKeyStatuses
    : DEFAULT_PROVIDER_KEY_STATUSES;
}
