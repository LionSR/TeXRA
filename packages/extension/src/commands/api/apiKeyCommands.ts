// Third-party imports
import { Effect, Stream } from 'effect';
import * as vscode from 'vscode';

// Local imports
import {
  API_KEY_PROVIDER_IDS,
  type ApiKeyProviderId,
  apiKeyOrigins,
} from '@texra-ai/llm';
import {
  Secrets,
  withLogChannel,
  type SettingsStores,
} from '@texra-ai/worldline/plugins';
import { vscodeOpener } from '@frontend/hosts/VscodeExternalOpener';
import { vscodeUi } from '@frontend/hosts/VscodeUiHost';
import { quickPick } from '@frontend/ui/dialogs';
import { eventStream } from '@frontend/vscode/vscodeEvents';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import {
  commitProviderKey,
  removeProviderKey,
} from '@texra/controllers/settingsView/providerKeyActions';
import {
  getProviderDisplayName,
  getProviderKeyUrl,
} from '@texra/model/providerPresentation';
import { credentialOriginLabel, PROVIDER_KEY_COPY } from '@ui/copy/credentials';

const CHANNEL = 'ApiKeyCommands';

interface ApiProviderQuickPickItem extends vscode.QuickPickItem {
  provider: ApiKeyProviderId;
}

/**
 * Prompt for an API key with a native button that opens the provider's key
 * portal without closing the input box, so the user can paste straight away.
 * Answers `undefined` when dismissed, and closes the input when the wait is
 * interrupted.
 */
function promptForApiKey(
  displayName: string,
  keyUrl: string | undefined,
): Effect.Effect<string | undefined> {
  const ib = vscode.window.createInputBox();
  ib.title = PROVIDER_KEY_COPY.set(displayName);
  ib.prompt = PROVIDER_KEY_COPY.enter(displayName);
  ib.password = true;
  ib.placeholder = '************************************';
  ib.ignoreFocusOut = true;
  const getKeyButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('link-external'),
    tooltip: `Get ${displayName} API key`,
    location: vscode.QuickInputButtonLocation?.Input,
  };
  ib.buttons = [getKeyButton];
  // The portal opens beside the prompt, for as long as it is open; a
  // browser that will not open is logged, and the prompt stays.
  const openKeyPortal = eventStream(ib.onDidTriggerButton).pipe(
    Stream.filter((button) => button === getKeyButton),
    Stream.runForEach(() =>
      keyUrl === undefined
        ? Effect.void
        : vscodeOpener
            .openExternal(keyUrl)
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning(error.message).pipe(withLogChannel(CHANNEL)),
              ),
            ),
    ),
  );
  // Disposing the input hides it, so an accepted value is followed by a
  // second `accept(undefined)`; `Effect.callback` ignores every `resume`
  // after the first, and `dispose` is idempotent.
  const answer = Effect.callback<string | undefined>((resume) => {
    const accept = (value: string | undefined): void => {
      resume(Effect.succeed(value));
      ib.dispose();
    };
    ib.onDidAccept(() => accept(ib.value));
    ib.onDidHide(() => accept(undefined));
    ib.show();
    return Effect.sync(() => ib.dispose());
  });
  return Effect.scoped(
    Effect.forkScoped(openKeyPortal).pipe(Effect.andThen(answer)),
  );
}

const pickApiProvider = Effect.fn('pickApiProvider')(function* (
  stores: SettingsStores,
  placeHolder: string,
  prompt: string,
) {
  // One batched read of the key statuses: the pick shows each provider's
  // stored/environment state.
  const origins = yield* apiKeyOrigins(yield* Secrets);
  const providerItems = yield* Effect.forEach(
    API_KEY_PROVIDER_IDS,
    (provider) =>
      Effect.map(getProviderDisplayName(stores, provider), (label) => ({
        label,
        description: credentialOriginLabel(origins[provider], 'key'),
        provider,
      })),
  );
  const providerPick = yield* quickPick<ApiProviderQuickPickItem>(
    providerItems,
    { placeHolder, prompt },
  );
  return providerPick?.provider;
});

/**
 * Set an API key. The command registry forwards a single typed argument, so
 * the optional `provider` is parsed at the dispatch boundary.
 */
export const setApiKey = Effect.fn('setApiKey')(function* (
  stores: SettingsStores,
  provider?: ApiKeyProviderId,
) {
  const target =
    provider ??
    (yield* pickApiProvider(
      stores,
      'Select API provider',
      'Keys stay on this machine, in an owner-only folder (~/.texra/secrets).',
    ));

  if (!target) return;

  const keyUrl = yield* getProviderKeyUrl(stores, target);
  const apiKey = yield* promptForApiKey(
    yield* getProviderDisplayName(stores, target),
    keyUrl,
  );
  if (!apiKey) return;

  // The same write the settings view's Profile tab makes, so the two
  // surfaces cannot drift apart on messaging.
  yield* commitProviderKey(vscodeUi, stores, target, apiKey).pipe(
    Effect.catchTag('ProviderKeyActionFailed', (error) =>
      showLoggedErrorMessage(error.message, error.cause),
    ),
  );
}, withLogChannel(CHANNEL));

/** Remove an API key after a confirmation prompt. */
export const removeApiKey = Effect.fn('removeApiKey')(function* (
  stores: SettingsStores,
) {
  const provider = yield* pickApiProvider(
    stores,
    'Select API provider to remove key',
    'Only removes the key from TeXRA — does not delete it from the provider.',
  );

  if (!provider) {
    return;
  }

  yield* removeProviderKey(vscodeUi, stores, provider).pipe(
    Effect.catchTag('ProviderKeyActionFailed', (error) =>
      showLoggedErrorMessage(error.message, error.cause),
    ),
  );
}, withLogChannel(CHANNEL));
