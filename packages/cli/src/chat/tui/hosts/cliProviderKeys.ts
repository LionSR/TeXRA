// The CLI's binding of the shared provider-key controller. Every terminal
// surface that writes a provider key — the "Connect a model" panel, `/key`,
// `/config`'s API-keys row, and the retry that asks for a key before
// switching a run onto it — goes through it, so the secret name, the label
// and the post-write refresh are the same three ways they are on the two
// graphical hosts. Its notices land in the chat transcript.

// Third-party imports
import { Effect, Fiber } from 'effect';

import { type ApiKeyProviderId, apiProviderOfSecretName } from '@texra-ai/llm';
import { onAppSignal } from '@eventBus/AppSignals';
import type { SettingsStores } from '@shared/config/settingsAccess';
import {
  ProviderKeyActionFailed,
  SettingsProfileKeyController,
} from '@texra/controllers/settingsView/SettingsProfileKeyController';
import { getProviderDisplayName } from '@texra/model/providerPresentation';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { bumpCodexPreferenceVersion } from '../state/cliState';
import { tuiUi } from './tuiUiHost';
import type { ProcessRuntime } from '@texra-ai/harness';
import type { PlatformSecrets } from '@texra-ai/harness';

/** Run one controller action on the TUI's prompt; a failure names its cause
 *  and stays in the Effect channel. */
const viaTui = (
  secrets: PlatformSecrets,
  stores: SettingsStores,
  action: (
    controller: SettingsProfileKeyController,
  ) => Effect.Effect<void, Error>,
): Effect.Effect<void, Error> =>
  action(
    new SettingsProfileKeyController({
      secrets,
      prompt: tuiUi,
      getProviderDisplayName: (candidate) =>
        getProviderDisplayName(stores, candidate),
    }),
  ).pipe(
    Effect.mapError((error) =>
      error instanceof ProviderKeyActionFailed
        ? new Error(`${error.message}: ${toErrorMessage(error.cause)}`, {
            cause: error,
          })
        : error,
    ),
  );

/** Write a key the calling surface already holds. */
export const commitCliProviderApiKey = (
  secrets: PlatformSecrets,
  stores: SettingsStores,
  provider: ApiKeyProviderId,
  key: string,
): Effect.Effect<void, Error> =>
  viaTui(secrets, stores, (controller) =>
    controller.commitProviderKey(provider, key),
  );

/**
 * Ask for a provider key and write it: the `promptForApiKey` the shared
 * retry controller calls when a run's fallback needs a credential the user
 * has not stored yet. A dismissed prompt is the answer "no key", not a
 * failure — the retry controller re-reads the store and reports `false`
 * itself.
 */
export const promptForCliProviderApiKey = (
  secrets: PlatformSecrets,
  stores: SettingsStores,
  provider: ApiKeyProviderId,
): Effect.Effect<void, Error> =>
  viaTui(secrets, stores, (controller) => controller.setProviderKey(provider));

/**
 * The chat TUI's `credentialChanged` subscriber, forked at its run edge (R1)
 * and interrupted by the returned disposer. The secret store announces every
 * committed write, whoever made it: `/key`, `/config`, the setup agent's
 * `unset_api_key`. A provider key bumps the subscription-preference level the
 * status bar and model pickers read. A key a tool plugin declares (the GitHub
 * token) is re-probed by the shared bootstrap. Other entries (OAuth tokens)
 * are ignored.
 */
export function subscribeCliCredentialChanges(
  runtime: ProcessRuntime,
): () => void {
  const fiber = runtime.runFork(
    onAppSignal('credentialChanged', ({ key }) => {
      if (apiProviderOfSecretName(key) !== undefined) {
        bumpCodexPreferenceVersion();
      }
    }),
  );
  return () => {
    runtime.runFork(Fiber.interrupt(fiber));
  };
}
