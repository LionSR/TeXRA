// Third-party imports
import * as vscode from 'vscode';

// Local imports
import {
  SecretManager,
  ApiProvider,
  ApiProviderQuickPickItem,
} from '@frontend/secretManager';

export const apiKeyCommands = {
  setApiKey: 'texra.setApiKey',
  removeApiKey: 'texra.removeApiKey',
};

const PROVIDER_LINKS: Record<ApiProvider, string> = {
  openai: 'https://platform.openai.com/account/api-keys',
  anthropic: 'https://console.anthropic.com/settings/keys',
  openRouter: 'https://openrouter.ai/keys',
  google: 'https://aistudio.google.com/app/apikey',
  xai: 'https://console.x.ai/',
  deepseek: 'https://platform.deepseek.com/api-keys',
  moonshot: 'https://platform.moonshot.cn/console/api-keys',
  dashscope: 'https://dashscope.aliyun.com/api-key',
  wolframllmapp: 'https://account.wolfram.com/access/api-key',
};

async function pickApiProvider(
  placeHolder: string,
): Promise<ApiProvider | undefined> {
  const providerItems = await SecretManager.getApiProviderQuickPickItems();
  const quickPick = vscode.window.createQuickPick<ApiProviderQuickPickItem>();
  quickPick.placeholder = placeHolder;
  quickPick.items = providerItems.map((item) => ({
    ...item,
    buttons: [
      {
        iconPath: new vscode.ThemeIcon('globe'),
        tooltip: 'Open API key documentation',
      },
    ],
  }));

  const selection = await new Promise<ApiProviderQuickPickItem | undefined>(
    (resolve) => {
      quickPick.onDidAccept(() => {
        resolve(quickPick.selectedItems[0]);
        quickPick.hide();
      });
      quickPick.onDidHide(() => {
        resolve(undefined);
        quickPick.dispose();
      });
      quickPick.onDidTriggerItemButton((event) => {
        const link = PROVIDER_LINKS[event.item.provider];
        if (link) {
          void vscode.env.openExternal(vscode.Uri.parse(link));
        }
      });
      quickPick.show();
    },
  );

  return selection?.provider;
}

export function registerApiKeyCommands(context: vscode.ExtensionContext) {
  // Command to set API key
  const setApiKeyCommand = vscode.commands.registerCommand(
    apiKeyCommands.setApiKey,
    async () => {
      // First select the provider
      const provider = await pickApiProvider('Select API provider');

      if (!provider) {
        return;
      }

      // Then get the API key
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
        vscode.window.showInformationMessage(
          `${provider} API key has been set`,
        );
      } catch (err) {
        vscode.window.showErrorMessage(
          `Failed to set ${provider} API key: ${err}`,
        );
      }
    },
  );

  // Command to remove API key
  const removeApiKeyCommand = vscode.commands.registerCommand(
    apiKeyCommands.removeApiKey,
    async () => {
      const provider = await pickApiProvider(
        'Select API provider to remove key',
      );

      if (!provider) {
        return;
      }

      try {
        await SecretManager.delete(SecretManager.getApiKeySecretName(provider));
        vscode.window.showInformationMessage(
          `${provider} API key has been removed`,
        );
      } catch (err) {
        vscode.window.showErrorMessage(
          `Failed to remove ${provider} API key: ${err}`,
        );
      }
    },
  );

  context.subscriptions.push(setApiKeyCommand, removeApiKeyCommand);

  return {
    setApiKeyCommand,
    removeApiKeyCommand,
  };
}
