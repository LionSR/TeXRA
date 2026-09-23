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
import { Effect, Fiber } from 'effect';

// Local imports - CLI runtime
import { cliExternalOpener } from '@cli/runtime/hosts/cliExternalOpener';
// Local imports - controllers
import {
  ProviderKeyActionFailed,
  SettingsProfileKeyController,
} from '@controllers/settingsView/SettingsProfileKeyController';
// Local imports - event bus
import { onAppSignal } from '@eventBus/AppSignals';
// Local imports - hosts
import { PromptFailed, type PromptHost } from '@hosts/uiHosts';
// Local imports - model
import { apiProviderOfSecretName, type ApiProvider } from '@model/apiProviders';
// Local imports - platform
import type { ProcessRuntime } from '@platform/processRuntime';
import type { PlatformSecrets } from '@platform/secrets';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
// Local imports - shared
import type { SettingsStores } from '@shared/config/settingsAccess';
import { providerDisplayName } from '@shared/constants/providers';
// Local imports - tools
import { GITHUB_TOKEN_STORAGE_KEY } from '@tools/github/githubAuth';
import { refreshToolAvailability } from '@tools/toolAvailability';
// Local imports - utils
import {
  getProviderDisplayName,
  getProviderKeyUrl,
} from '@utils/config/providerConfig';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { bumpCodexPreferenceVersion } from '../state/cliState';
import { tuiUi } from './tuiUiHost';

/** Write through the calling surface; failures stay in the Effect channel. */
const commitProviderApiKeyVia = Effect.fn('commitProviderApiKeyVia')(function* (
  prompt: Pick<PromptHost, 'input' | 'info' | 'confirm'>,
  secrets: PlatformSecrets,
  stores: SettingsStores,
  provider: ApiProvider,
  key: string,
) {
  const controller = new SettingsProfileKeyController({
    secrets,
    prompt,
    externalOpener: cliExternalOpener,
    getProviderDisplayName: (candidate) =>
      getProviderDisplayName(stores, candidate, providerDisplayName(candidate)),
    getProviderKeyUrl: (candidate) => getProviderKeyUrl(stores, candidate),
    // Nothing to repaint here: the store drops the API-key lookup cache on
    // commit, and the chat TUI's `credentialChanged` subscriber bumps the
    // subscription-preference level the status bar and model pickers read.
    refreshAfterKeyChange: () => Effect.void,
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
  const label = yield* getProviderDisplayName(
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

/**
 * The chat TUI's `credentialChanged` subscriber, forked at its run edge (R1)
 * and interrupted by the returned disposer. The secret store announces every
 * committed write, whoever made it: `/key`, `/config`, the setup agent's
 * `unset_api_key`. A provider key bumps the subscription-preference level the
 * status bar and model pickers read. The GitHub token re-probes tool
 * availability, whose cache the next run's tool list reads. Other entries
 * (OAuth tokens, sign-in nonces) are ignored.
 */
export function subscribeCliCredentialChanges(
  runtime: ProcessRuntime,
  roots: Pick<WorkspaceRoots, 'workspace' | 'config'>,
): () => void {
  const fiber = runtime.runFork(
    onAppSignal('credentialChanged', ({ key }) => {
      if (apiProviderOfSecretName(key) !== undefined) {
        bumpCodexPreferenceVersion();
      } else if (key === GITHUB_TOKEN_STORAGE_KEY) {
        runtime.runFork(
          refreshToolAvailability({
            workspaceRoot: roots.workspace,
            config: roots.config,
          }),
        );
      }
    }),
  );
  return () => {
    runtime.runFork(Fiber.interrupt(fiber));
  };
}
