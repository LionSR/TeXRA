// The CLI's binding of the shared provider-key controller. Every terminal
// surface that writes a provider key — the "Connect a model" panel, `/key`,
// `/config`'s API-keys row, and the retry that asks for a key before
// switching a run onto it — goes through this one program, so the secret
// name, the label and the post-write refresh are the same three ways they
// are on the two graphical hosts.
//
// What each surface still owns is where the controller's notice lands (the
// chat TUI has a transcript to put it in), so the prompt port is the
// parameter of the one body below and each surface binds its own.

// Third-party imports
import { Effect, Fiber } from 'effect';

// Local imports - CLI runtime
import { type ApiKeyProviderId, apiProviderOfSecretName } from '@texra-ai/llm';
import { cliExternalOpener } from '@cli/runtime/hosts/cliExternalOpener';
// Local imports - controllers
// Local imports - event bus
import { onAppSignal } from '@eventBus/AppSignals';
// Local imports - hosts
// Local imports - model
// Local imports - platform
// Local imports - shared
import type { SettingsStores } from '@shared/config/settingsAccess';
import type { PromptHost } from '@texra/hosts/uiHosts';
import {
  ProviderKeyActionFailed,
  SettingsProfileKeyController,
} from '@texra/controllers/settingsView/SettingsProfileKeyController';
// Local imports - utils
import {
  getProviderDisplayName,
  getProviderKeyUrl,
} from '@texra/model/providerPresentation';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { bumpCodexPreferenceVersion } from '../state/cliState';
import { tuiUi } from './tuiUiHost';
import type { ProcessRuntime } from '@texra-ai/harness';
import type { PlatformSecrets } from '@texra-ai/harness';

/** Write through the calling surface; failures stay in the Effect channel. */
const commitProviderApiKeyVia = Effect.fn('commitProviderApiKeyVia')(function* (
  prompt: Pick<PromptHost, 'input' | 'info' | 'confirm'>,
  secrets: PlatformSecrets,
  stores: SettingsStores,
  provider: ApiKeyProviderId,
  key: string,
) {
  const controller = new SettingsProfileKeyController({
    secrets,
    prompt,
    externalOpener: cliExternalOpener,
    getProviderDisplayName: (candidate) =>
      getProviderDisplayName(stores, candidate),
    getProviderKeyUrl: (candidate) => getProviderKeyUrl(stores, candidate),
  });
  yield* controller.commitProviderKey(provider, key).pipe(
    Effect.mapError((error) =>
      error instanceof ProviderKeyActionFailed
        ? new Error(`${error.message}: ${toErrorMessage(error.cause)}`, {
            cause: error,
          })
        : error,
    ),
  );
});

/**
 * The chat TUI's binding: the notice the controller raises lands in the
 * transcript, beside the `/key` or `/config` row that asked for the write.
 */
export const commitCliProviderApiKey = (
  secrets: PlatformSecrets,
  stores: SettingsStores,
  provider: ApiKeyProviderId,
  key: string,
): Effect.Effect<void, Error> =>
  commitProviderApiKeyVia(tuiUi, secrets, stores, provider, key);

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
  provider: ApiKeyProviderId,
) {
  const label = yield* getProviderDisplayName(stores, provider);
  const key = yield* tuiUi.input({
    prompt: `Enter ${label} API key`,
    placeHolder: 'enter your API key (hidden)',
    password: true,
  });
  if (key == null) return;
  yield* commitCliProviderApiKey(secrets, stores, provider, key);
});

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
