// Third-party imports
import { Effect, Queue, Stream } from 'effect';
import * as vscode from 'vscode';

// Local imports
import {
  API_KEY_PROVIDER_IDS,
  type ApiKeyProviderId,
  loadApiKeyStatusMap,
} from '@texra-ai/llm';
import { Secrets, withLogChannel } from '@texra-ai/harness';
import { VscodeExternalOpener } from '@frontend/hosts/VscodeExternalOpener';
import { vscodeUi } from '@frontend/hosts/VscodeUiHost';
import { quickPick } from '@frontend/ui/dialogs';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import { SettingsProfileKeyController } from '@texra/controllers/settingsView/SettingsProfileKeyController';
import { getProviderKeyUrl } from '@texra/model/providerPresentation';
import type { SettingsStores } from '@texra-ai/harness';

const CHANNEL = 'ApiKeyCommands';

interface ApiProviderQuickPickItem extends vscode.QuickPickItem {
  provider: ApiKeyProviderId;
}

/**
 * Delegates the write/delete/confirm/notify sequence to the same controller
 * settingsView's Profile tab uses, so the two surfaces can't drift apart on
 * confirmation prompts or messaging (see SettingsProfileKeyController).
 */
function createProfileKeyController(
  stores: SettingsStores,
): SettingsProfileKeyController {
  return new SettingsProfileKeyController({ prompt: vscodeUi, stores });
}

/**
 * Prompt for an API key with a native button that opens the provider's key
 * portal without closing the input box, so the user can paste straight away.
 * Answers `undefined` when dismissed, and closes the input when the wait is
 * interrupted.
 */
function promptForApiKey(
  provider: ApiKeyProviderId,
  keyUrl: string | undefined,
): Effect.Effect<string | undefined> {
  const ib = vscode.window.createInputBox();
  ib.title = `Set ${provider} API key`;
  ib.prompt = `Enter ${provider} API key`;
  ib.password = true;
  ib.placeholder = '************************************';
  ib.ignoreFocusOut = true;
  const getKeyButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('link-external'),
    tooltip: `Get ${provider} API key`,
    location: vscode.QuickInputButtonLocation?.Input,
  };
  ib.buttons = [getKeyButton];
  // The portal opens beside the prompt, for as long as it is open; a
  // browser that will not open is logged, and the prompt stays.
  const openKeyPortal = Stream.callback<void>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() =>
        ib.onDidTriggerButton((button) => {
          if (button === getKeyButton) Queue.offerUnsafe(queue, undefined);
        }),
      ),
      (listener) => Effect.sync(() => listener.dispose()),
    ),
  ).pipe(
    Stream.runForEach(() =>
      keyUrl === undefined
        ? Effect.void
        : new VscodeExternalOpener()
            .openExternal(keyUrl)
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning(error.message).pipe(withLogChannel(CHANNEL)),
              ),
            ),
    ),
  );
  const answer = Effect.callback<string | undefined>((resume) => {
    let settled = false;
    const accept = (value: string | undefined): void => {
      if (settled) return;
      settled = true;
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

function pickApiProvider(placeHolder: string, prompt: string) {
  return Effect.gen(function* () {
    // One batched read of the key statuses: the pick shows each provider's
    // stored/environment state.
    const statuses = yield* loadApiKeyStatusMap(yield* Secrets);
    const providerItems = API_KEY_PROVIDER_IDS.map((provider) => ({
      label: provider,
      description: statuses[provider] === 'not-set' ? 'not set' : 'key set',
      provider,
    }));
    const providerPick = yield* quickPick<ApiProviderQuickPickItem>(
      providerItems,
      { placeHolder, prompt },
    );
    return providerPick?.provider;
  });
}

/**
 * Set an API key. The command registry forwards a single typed argument, so
 * the optional `provider` is parsed at the dispatch boundary.
 */
export function setApiKey(stores: SettingsStores, provider?: ApiKeyProviderId) {
  return Effect.gen(function* () {
    const target =
      provider ??
      (yield* pickApiProvider(
        'Select API provider',
        'Keys stay on this machine, in an owner-only folder (~/.texra/secrets).',
      ));

    if (!target) return;

    const keyUrl = yield* getProviderKeyUrl(stores, target);
    const apiKey = yield* promptForApiKey(target, keyUrl);
    if (!apiKey) return;

    yield* createProfileKeyController(stores)
      .commitProviderKey(target, apiKey)
      .pipe(
        Effect.catchTag('ProviderKeyActionFailed', (error) =>
          showLoggedErrorMessage(CHANNEL, error.message, error.cause),
        ),
      );
  });
}

/** Remove an API key after a confirmation prompt. */
export function removeApiKey(stores: SettingsStores) {
  return Effect.gen(function* () {
    const provider = yield* pickApiProvider(
      'Select API provider to remove key',
      'Only removes the key from TeXRA — does not delete it from the provider.',
    );

    if (!provider) {
      return;
    }

    yield* createProfileKeyController(stores)
      .removeProviderKey(provider)
      .pipe(
        Effect.catchTag('ProviderKeyActionFailed', (error) =>
          showLoggedErrorMessage(CHANNEL, error.message, error.cause),
        ),
      );
  });
}
