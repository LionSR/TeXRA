// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { settleQuickInput } from '@commands/_shared/quickInputUtils';
import { SettingsProfileKeyController } from '@controllers/settingsView/SettingsProfileKeyController';
import {
  SecretManager,
  ApiProvider,
  type ApiProviderQuickPickItem,
} from '@frontend/secretManager';
import { VscodeExternalOpener } from '@frontend/hosts/VscodeExternalOpener';
import { VscodePromptHost } from '@frontend/hosts/VscodePromptHost';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import { getMainWebview } from '@frontend/system/commandUtils';
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import { PROVIDER_DISPLAY_NAMES } from '@shared/constants/providers';
import { refreshApiKeyCaches } from '@tools/setup/apiKeyHelpers';
import { getSetupPlatform } from '@tools/setup/platform';
import {
  getProviderDisplayName,
  getProviderKeyUrl,
} from '@utils/config/providerConfig';

const CHANNEL = 'ApiKeyCommands';

export const apiKeyCommands = {
  setApiKey: 'texra.setApiKey',
};

/**
 * Delegates the write/delete/confirm/notify sequence to the same controller
 * settingsView's Profile tab uses, so the two surfaces can't drift apart on
 * confirmation prompts or messaging (see SettingsProfileKeyController).
 */
function createProfileKeyController(): SettingsProfileKeyController {
  return new SettingsProfileKeyController({
    prompt: new VscodePromptHost(),
    externalOpener: new VscodeExternalOpener(),
    getProviderDisplayName: (provider) =>
      getProviderDisplayName(
        provider,
        PROVIDER_DISPLAY_NAMES[provider] ?? provider,
      ),
    getProviderKeyUrl,
    getApiKeySecretName: (provider) =>
      SecretManager.getApiKeySecretName(provider as ApiProvider),
    setSecret: (key, value) => SecretManager.set(key, value),
    deleteSecret: (key) => SecretManager.delete(key),
    refreshAfterKeyChange: async () => {
      await refreshApiKeyCaches(getSetupPlatform());
      const view = await getMainWebview();
      const anyKeyExists = await SecretManager.anyApiKeyExists();
      view?.webview.postMessage({
        command: anyKeyExists
          ? MAIN_VIEW_COMMANDS.HIDE_API_KEY_BANNER
          : MAIN_VIEW_COMMANDS.SHOW_API_KEY_BANNER,
      });
    },
  });
}

async function setApiKeyForProvider(provider: ApiProvider): Promise<void> {
  const apiKey = await promptForApiKey(provider);

  if (!apiKey) {
    return;
  }

  try {
    await createProfileKeyController().commitProviderKey(provider, apiKey);
  } catch (err) {
    await showLoggedErrorMessage(
      CHANNEL,
      `Failed to set ${provider} API key`,
      err,
    );
  }
}

/**
 * Prompt for an API key with a native button that opens the provider's key
 * portal without closing the input box, so the user can paste straight away.
 */
async function promptForApiKey(
  provider: ApiProvider,
): Promise<string | undefined> {
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
      const keyUrl = getProviderKeyUrl(provider);
      if (keyUrl) void vscode.env.openExternal(vscode.Uri.parse(keyUrl));
    }
  });
  return settleQuickInput(ib, (accept) => {
    ib.onDidAccept(() => {
      accept(ib.value);
    });
  });
}

async function pickApiProvider(
  placeHolder: string,
  prompt: string,
): Promise<ApiProvider | undefined> {
  const providerItems = await SecretManager.getApiProviderQuickPickItems();
  const providerPick =
    await vscode.window.showQuickPick<ApiProviderQuickPickItem>(providerItems, {
      placeHolder,
      prompt,
    });
  return providerPick?.provider;
}

/**
 * Set an API key. Migrated to the shared command registry in
 * #3781 batch 4. The registry forwards a single typed argument so the
 * optional `provider` is parsed at the dispatch boundary.
 */
export async function setApiKey(provider?: ApiProvider): Promise<void> {
  const target =
    provider ??
    (await pickApiProvider(
      'Select API provider',
      "Keys are stored in VS Code's encrypted secret store, never on disk.",
    ));

  if (target) {
    await setApiKeyForProvider(target);
  }
}

/**
 * Remove an API key after a confirmation prompt. Migrated to the shared
 * command registry in #3781 batch 4.
 */
export async function removeApiKey(): Promise<void> {
  const provider = await pickApiProvider(
    'Select API provider to remove key',
    'Only removes the key from TeXRA — does not delete it from the provider.',
  );

  if (!provider) {
    return;
  }

  try {
    await createProfileKeyController().removeProviderKey(provider);
  } catch (err) {
    await showLoggedErrorMessage(
      CHANNEL,
      `Failed to remove ${provider} API key`,
      err,
    );
  }
}
