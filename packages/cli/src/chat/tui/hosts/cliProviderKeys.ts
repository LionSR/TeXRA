// The CLI's binding of the shared provider-key controller. Every terminal
// surface that writes a provider key — first-run onboarding, `/key`,
// `/config`'s API-keys row, and the retry that asks for a key before
// switching a run onto it — goes through this one program, so the secret
// name, the label and the post-write refresh are the same three ways they
// are on the two graphical hosts.
//
// What each surface still owns is where the controller's notice lands: the
// chat TUI has a transcript to put it in, the onboarding wizard prints its
// own confirmation on exit. So the prompt port is the parameter of the one
// body below and each surface binds its own.

// Third-party imports
import { Effect } from 'effect';

// Local imports - CLI runtime
import { cliExternalOpener } from '@cli/runtime/hosts/cliExternalOpener';
// Local imports - controllers
import { SettingsProfileKeyController } from '@controllers/settingsView/SettingsProfileKeyController';
// Local imports - hosts
import { PromptFailed, type PromptHost } from '@hosts/uiHosts';
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
 * Write one provider key through the prompt surface the caller is on, and
 * fail with what the write could not do.
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
const commitProviderApiKeyVia = Effect.fn('commitProviderApiKeyVia')(function* (
  prompt: Pick<PromptHost, 'input' | 'info' | 'confirm'>,
  secrets: PlatformSecrets,
  stores: SettingsStores,
  provider: ApiProvider,
  key: string,
) {
  let reported: Error | undefined;
  const controller = new SettingsProfileKeyController({
    secrets,
    prompt,
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
  if (reported) yield* Effect.fail(reported);
});

/**
 * The chat TUI's binding: the notice the controller raises lands in the
 * transcript, beside the `/key` or `/config` row that asked for the write.
 */
export const commitCliProviderApiKey = (
  secrets: PlatformSecrets,
  stores: SettingsStores,
  provider: ApiProvider,
  key: string,
): Effect.Effect<void, Error> =>
  commitProviderApiKeyVia(tuiUi, secrets, stores, provider, key);

/**
 * The onboarding wizard's dialog surface. The wizard is its own Ink app, run
 * before the chat TUI mounts (and, under `texra setup`, in the same process
 * as the chat TUI that follows): it renders every step in its own frame and
 * states the outcome in the summary it prints on exit.
 *
 * `info` is silent here by design, not by omission. The one notice this path
 * raises — "<Provider> API key has been set" — is the fact the wizard already
 * prints, with the secret name and the environment variable the generic
 * notice cannot know. Sending it to the chat transcript instead would post a
 * row into a signal the wizard does not render, which the user's first chat
 * run then adopts as its opening line.
 *
 * `confirm` and `input` have no surface here at all: nothing on the
 * onboarding path reaches them (the controller opens them only from
 * `setProviderKey`/`removeProviderKey`, which the wizard does not call). They
 * fail rather than answer a dismissal the user never made, so a caller that
 * did reach them sees the fault instead of a silent "no".
 */
const onboardingUi: Pick<PromptHost, 'input' | 'info' | 'confirm'> = {
  info: () => Effect.succeed(undefined),
  confirm: (message) =>
    Effect.fail(
      new PromptFailed({
        reason: 'host-unavailable',
        member: 'confirm',
        message: `The onboarding wizard has no confirmation dialog: ${message}`,
      }),
    ),
  input: (options) =>
    Effect.fail(
      new PromptFailed({
        reason: 'host-unavailable',
        member: 'input',
        message: `The onboarding wizard has no input dialog: ${options.prompt ?? 'input'}`,
      }),
    ),
};

/**
 * The onboarding wizard's binding: the same write, the same refresh, the same
 * relayed failure the wizard shows in place — and no transcript notice.
 */
export const commitOnboardingProviderApiKey = (
  secrets: PlatformSecrets,
  stores: SettingsStores,
  provider: ApiProvider,
  key: string,
): Effect.Effect<void, Error> =>
  commitProviderApiKeyVia(onboardingUi, secrets, stores, provider, key);

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
