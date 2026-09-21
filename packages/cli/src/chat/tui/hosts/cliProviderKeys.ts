// The CLI's binding of the shared provider-key controller. Every terminal
// surface that writes a provider key — first-run onboarding, `/key`,
// `/config`'s API-keys row, and the retry that asks for a key before
// switching a run onto it — goes through this one program, so the secret
// name, the label, the confirmation wording and the post-write refresh are
// the same three ways they are on the two graphical hosts.

// Third-party imports
import { Effect } from 'effect';

// Local imports - controllers
import { SettingsProfileKeyController } from '@controllers/settingsView/SettingsProfileKeyController';
// Local imports - CLI runtime
import { cliExternalOpener } from '@cli/runtime/hosts/cliExternalOpener';
// Local imports - model
import { invalidateApiKeyCache, type ApiProvider } from '@model/apiProviders';
// Local imports - platform
import type { PlatformSecrets } from '@platform/secrets';
// Local imports - shared
import type { SettingsStores } from '@shared/config/settingsAccess';
import { providerDisplayName } from '@shared/constants/providers';
// Local imports - utils
import {
  getProviderDisplayName,
  getProviderKeyUrl,
} from '@utils/config/providerConfig';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { bumpCodexPreferenceVersion } from '../state/cliState';
import { tuiUi } from './tuiUiHost';

/**
 * Write one provider key, and fail with what the write could not do.
 *
 * {@link SettingsProfileKeyController} reports a failed key action instead of
 * raising it: every graphical caller of it is a message handler with nowhere
 * to put an error. The CLI's key forms do have somewhere — they show the
 * failure in place so the user can retype the key without losing the screen —
 * so the report is relayed back out here rather than swallowed, and this
 * program keeps the failure channel those forms already match on.
 *
 * The cache drop is this host's `refreshAfterKeyChange`, exactly as it is the
 * other two hosts': one CLI site, reached by every surface, instead of a copy
 * beside each write.
 */
export const commitCliProviderApiKey = Effect.fn('commitCliProviderApiKey')(
  function* (
    secrets: PlatformSecrets,
    stores: SettingsStores,
    provider: ApiProvider,
    key: string,
  ) {
    let reported: Error | undefined;
    const controller = new SettingsProfileKeyController({
      secrets,
      prompt: tuiUi,
      externalOpener: cliExternalOpener,
      getProviderDisplayName: (candidate) =>
        getProviderDisplayName(stores, candidate, providerDisplayName(candidate)),
      getProviderKeyUrl: (candidate) => getProviderKeyUrl(stores, candidate),
      // The key-dependent state this host repaints: the process's API-key
      // lookup cache, and the subscription-preference level the status bar
      // and the model pickers read.
      refreshAfterKeyChange: () =>
        Effect.sync(() => {
          invalidateApiKeyCache();
          bumpCodexPreferenceVersion();
        }),
      reportFailure: (message, error) =>
        Effect.sync(() => {
          reported = new Error(`${message}: ${toErrorMessage(error)}`);
        }),
    });
    yield* controller.commitProviderKey(provider, key);
    if (reported) return yield* Effect.fail(reported);
  },
);

/**
 * Ask for a provider key and write it: the `promptForApiKey` the shared
 * retry controller calls when a run's fallback needs a credential the user
 * has not stored yet. A dismissed prompt is the answer "no key", not a
 * failure — the retry controller re-reads the store and reports `false`
 * itself.
 */
export const promptForCliProviderApiKey = Effect.fn(
  'promptForCliProviderApiKey',
)(function* (
  secrets: PlatformSecrets,
  stores: SettingsStores,
  provider: ApiProvider,
) {
  const label = getProviderDisplayName(
    stores,
    provider,
    providerDisplayName(provider),
  );
  const key = yield* tuiUi.input({
    prompt: `Enter ${label} API key`,
    placeHolder: 'enter your API key (hidden)',
    password: true,
  });
  if (key == null) return;
  yield* commitCliProviderApiKey(secrets, stores, provider, key);
});
