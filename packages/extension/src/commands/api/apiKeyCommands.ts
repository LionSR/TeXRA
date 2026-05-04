// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { MAIN_VIEW_COMMANDS } from '@common/webview';
import { SecretManager, ApiProvider } from '@frontend/secretManager';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import { getMainWebview } from '@frontend/system/commandUtils';
import * as logger from '@logger/logUtils';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import { PROVIDER_URLS } from '@shared/constants/providers';

const CHANNEL = 'ApiKeyCommands';
logger.initialize(CHANNEL);

export const apiKeyCommands = {
  setApiKey: 'texra.setApiKey',
  removeApiKey: 'texra.removeApiKey',
};

async function refreshApiKeyUI(): Promise<void> {
  invalidateModelOptionsCache();
  await vscode.commands.executeCommand('texra.refreshApiKeyStatus');
  await vscode.commands.executeCommand('texra.refreshAllOptions');
}

async function setApiKeyForProvider(
  provider: ApiProvider,
  skipDialog = false,
): Promise<void> {
  if (!skipDialog) {
    const actions: Array<vscode.MessageItem & { id: 'enter' | 'getApiKey' }> = [
      { title: 'Enter Key', id: 'enter' },
      { title: 'Get API Key', id: 'getApiKey' },
    ];
    const action = await vscode.window.showInformationMessage(
      `Set your ${provider} API key`,
      ...actions,
    );

    if (!action) {
      return;
    }

    if (action.id === 'getApiKey') {
      await vscode.env.openExternal(vscode.Uri.parse(PROVIDER_URLS[provider]));
      return;
    }
  }

  const apiKey = await vscode.window.showInputBox({
    prompt: `Enter ${provider} API key`,
    password: true,
    placeHolder: '************************************',
  });

  if (!apiKey) {
    return;
  }

  try {
    await SecretManager.set(
      SecretManager.getApiKeySecretName(provider),
      apiKey,
    );
    vscode.window.showInformationMessage(`${provider} API key has been set`);
    await refreshApiKeyUI();
    const view = await getMainWebview();
    view?.webview.postMessage({
      command: MAIN_VIEW_COMMANDS.HIDE_API_KEY_BANNER,
    });
  } catch (err) {
    await showLoggedErrorMessage(
      CHANNEL,
      `Failed to set ${provider} API key`,
      err,
    );
  }
}

export function registerApiKeyCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      apiKeyCommands.setApiKey,
      async (provider?: ApiProvider) => {
        if (provider) {
          await setApiKeyForProvider(provider, true);
          return;
        }

        const providerItems =
          await SecretManager.getApiProviderQuickPickItems();
        const providerPick = await vscode.window.showQuickPick(providerItems, {
          placeHolder: 'Select API provider',
        });

        if (providerPick?.provider) {
          await setApiKeyForProvider(providerPick.provider);
        }
      },
    ),

    vscode.commands.registerCommand(apiKeyCommands.removeApiKey, async () => {
      const providerItems = await SecretManager.getApiProviderQuickPickItems();
      const providerPick = await vscode.window.showQuickPick(providerItems, {
        placeHolder: 'Select API provider to remove key',
      });

      const provider = providerPick?.provider;
      if (!provider) {
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Remove the ${provider} API key? This cannot be undone.`,
        'Remove',
        'Cancel',
      );
      if (confirm !== 'Remove') {
        return;
      }

      try {
        await SecretManager.delete(SecretManager.getApiKeySecretName(provider));
        vscode.window.showInformationMessage(
          `${provider} API key has been removed`,
        );
        await refreshApiKeyUI();
        const view = await getMainWebview();
        view?.webview.postMessage({
          command: (await SecretManager.anyApiKeyExists())
            ? MAIN_VIEW_COMMANDS.HIDE_API_KEY_BANNER
            : MAIN_VIEW_COMMANDS.SHOW_API_KEY_BANNER,
        });
      } catch (err) {
        await showLoggedErrorMessage(
          CHANNEL,
          `Failed to remove ${provider} API key`,
          err,
        );
      }
    }),
  );
}
