import { Secrets, Settings } from '@texra-ai/harness/host';
import { Effect } from 'effect';
import { API_KEY_PROVIDER_IDS, apiKeyOrigins } from '@texra-ai/llm';
import { providerEndpointKey } from '@texra-ai/harness/schemas';
import { TEXRA_SETTINGS } from '@texra/shared/settingsView/texraSettings';
import type { SettingsHostState } from '@texra/shared/settingsView/settingsViewMessages';
import { getProviderDisplayName } from '@texra/model/providerPresentation';
import type { SettingsStores } from '@texra-ai/harness/host';

/**
 * The profile page for either host: every
 * canonical provider id with its key status, read from the process
 * `Secrets`, and its native controls, read from the three setting slots.
 */
export const buildProfilePage = Effect.fn('buildProfilePage')(function* (
  stores: SettingsStores,
): Effect.fn.Return<SettingsHostState['profile'], Error, Secrets> {
  const origins = yield* apiKeyOrigins(yield* Secrets);
  return {
    providerKeyStatuses: yield* Effect.forEach(
      API_KEY_PROVIDER_IDS,
      Effect.fnUntraced(function* (provider) {
        const endpointKey = providerEndpointKey(provider);
        return {
          provider,
          displayName: yield* getProviderDisplayName(stores, provider),
          status: origins[provider],
          customEndpoint: endpointKey
            ? yield* Settings.get<string>(stores, endpointKey)
            : '',
          supportsCustomEndpoint: endpointKey !== undefined,
          providerSettings: yield* providerSettings(stores, provider),
        };
      }),
    ),
  };
});

function providerSettings(stores: SettingsStores, provider: string) {
  return Effect.forEach(
    TEXRA_SETTINGS.modelsTab(provider),
    ({ entry, surface }) =>
      Settings.get(stores, entry.key).pipe(
        Effect.map((value) => ({
          ...surface,
          key: entry.key,
          value: value === true,
        })),
      ),
  );
}
