// Third-party imports
import { Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports
import {
  API_KEY_PROVIDER_IDS,
  type ApiKeyProviderId,
  loadApiKeyStatusMap,
} from '@texra-ai/llm';
import { settleQuickInput } from '@commands/_shared/quickInputUtils';
import { VscodeExternalOpener } from '@frontend/hosts/VscodeExternalOpener';
import { vscodeUi } from '@frontend/hosts/VscodeUiHost';
import { quickPick } from '@frontend/ui/dialogs';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { SettingsProfileKeyController } from '@texra/controllers/settingsView/SettingsProfileKeyController';
import {
  getProviderDisplayName,
  getProviderKeyUrl,
} from '@texra/model/providerPresentation';
import type { PlatformSecrets } from '@texra-ai/harness';

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
  secrets: PlatformSecrets,
): SettingsProfileKeyController {
  return new SettingsProfileKeyController({
    secrets,
    prompt: vscodeUi,
    externalOpener: new VscodeExternalOpener(),
    getProviderDisplayName: (provider) =>
      getProviderDisplayName(stores, provider),
    getProviderKeyUrl: (provider) => getProviderKeyUrl(stores, provider),
  });
}

/**
 * Prompt for an API key with a native button that opens the provider's key
 * portal without closing the input box, so the user can paste straight away.
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
  ib.onDidTriggerButton((button) => {
    if (button === getKeyButton) {
      if (keyUrl) void vscode.env.openExternal(vscode.Uri.parse(keyUrl));
    }
  });
  return settleQuickInput(ib, (accept) => {
    ib.onDidAccept(() => {
      accept(ib.value);
    });
  });
}

function pickApiProvider(
  secrets: PlatformSecrets,
  placeHolder: string,
  prompt: string,
) {
  return Effect.gen(function* () {
    // One batched read of the key statuses: the pick shows each provider's
    // stored/environment state.
    const statuses = yield* loadApiKeyStatusMap(secrets, API_KEY_PROVIDER_IDS);
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
 * Set an API key. Migrated to the shared command registry in
 * #3781 batch 4. The registry forwards a single typed argument so the
 * optional `provider` is parsed at the dispatch boundary.
 */
export function setApiKey(
  stores: SettingsStores,
  secrets: PlatformSecrets,
  provider?: ApiKeyProviderId,
) {
  return Effect.gen(function* () {
    const target =
      provider ??
      (yield* pickApiProvider(
        secrets,
        'Select API provider',
        "Keys are stored in VS Code's encrypted secret store, never on disk.",
      ));

    if (!target) return;

    const keyUrl = yield* getProviderKeyUrl(stores, target);
    const apiKey = yield* promptForApiKey(target, keyUrl);
    if (!apiKey) return;

    yield* createProfileKeyController(stores, secrets)
      .commitProviderKey(target, apiKey)
      .pipe(
        Effect.catchTag('ProviderKeyActionFailed', (error) =>
          showLoggedErrorMessage(CHANNEL, error.message, error.cause),
        ),
      );
  });
}

/**
 * Remove an API key after a confirmation prompt. Migrated to the shared
 * command registry in #3781 batch 4.
 */
export function removeApiKey(stores: SettingsStores, secrets: PlatformSecrets) {
  return Effect.gen(function* () {
    const provider = yield* pickApiProvider(
      secrets,
      'Select API provider to remove key',
      'Only removes the key from TeXRA — does not delete it from the provider.',
    );

    if (!provider) {
      return;
    }

    yield* createProfileKeyController(stores, secrets)
      .removeProviderKey(provider)
      .pipe(
        Effect.catchTag('ProviderKeyActionFailed', (error) =>
          showLoggedErrorMessage(CHANNEL, error.message, error.cause),
        ),
      );
  });
}
