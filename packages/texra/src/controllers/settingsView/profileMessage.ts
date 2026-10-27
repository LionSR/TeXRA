import { Settings } from '@texra-ai/harness';
import { Effect } from 'effect';
import {
  API_KEY_PROVIDER_IDS,
  loadApiKeyStatusMap,
  type CredentialStore,
} from '@texra-ai/llm';
import { providerEndpointKey } from '@texra-ai/harness/schemas';
import { SETTINGS_VIEW_COMMANDS } from '@texra/shared/ipc';
import { TEXRA_SETTINGS } from '@texra/shared/settingsView/texraSettings';
import type { UpdateProfileMessage } from '@texra/shared/settingsView/settingsViewMessages';
import { getProviderDisplayName } from '@texra/model/providerPresentation';
import type { SettingsStores } from '@texra-ai/harness';

/**
 * Assemble the canonical `UPDATE_PROFILE` message for either host: every
 * canonical provider id with its key status, read from the host's secret
 * store, and its native controls, read from the three setting slots.
 */
export const buildProfileMessage = Effect.fn('buildProfileMessage')(function* (
  stores: SettingsStores,
  secrets: CredentialStore,
): Effect.fn.Return<UpdateProfileMessage, Error> {
  const secretStatuses = yield* loadApiKeyStatusMap(secrets);
  return {
    command: SETTINGS_VIEW_COMMANDS.UPDATE_PROFILE,
    providerKeyStatuses: yield* Effect.forEach(
      API_KEY_PROVIDER_IDS,
      (provider) =>
        Effect.gen(function* () {
          const endpointKey = providerEndpointKey(provider);
          return {
            provider,
            displayName: yield* getProviderDisplayName(stores, provider),
            status: secretStatuses[provider],
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
        Effect.map((value) => {
          const { provider: _provider, ...display } = surface;
          return { ...display, key: entry.key, value: value === true };
        }),
      ),
  );
}
