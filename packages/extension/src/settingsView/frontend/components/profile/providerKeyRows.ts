// Local imports - shared schemas and constants
import type { ProviderKeyStatus } from '@shared/schemas/settingsViewMessages';
import {
  API_KEY_PROVIDER_IDS,
  PROVIDER_DISPLAY_NAMES,
  PROVIDER_URLS,
} from '@shared/constants/providers';

/**
 * Shared placeholder rows. Frozen because every caller receives the same
 * array: a render-time edit to one row would leak into every later fallback.
 */
const DEFAULT_PROVIDER_KEY_STATUSES: readonly ProviderKeyStatus[] =
  Object.freeze(
    API_KEY_PROVIDER_IDS.map((provider) =>
      Object.freeze({
        provider,
        displayName: PROVIDER_DISPLAY_NAMES[provider] ?? provider,
        status: 'not-set' as const,
        keyUrl: PROVIDER_URLS[provider] ?? '',
        streaming: true,
        customEndpoint: '',
        supportsCustomEndpoint: false,
        providerSettings: [],
      }),
    ),
  );

/**
 * Keep provider API-key controls available even before profile state arrives.
 */
export function resolveProviderKeyRows(
  providerKeyStatuses: readonly ProviderKeyStatus[],
): readonly ProviderKeyStatus[] {
  return providerKeyStatuses.length > 0
    ? providerKeyStatuses
    : DEFAULT_PROVIDER_KEY_STATUSES;
}
