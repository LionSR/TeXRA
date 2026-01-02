// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { showLoggedErrorMessage } from '@common/errors';
import { MAIN_VIEW_COMMANDS } from '@common/webview';
import { SecretManager, ApiProvider } from '@frontend/secretManager';
import { getMainWebview } from '@frontend/system/commandUtils';

const CHANNEL = 'ApiKeyCommands';

export const PROVIDER_URLS: Record<ApiProvider, string> = {
  openai: 'https://platform.openai.com/api-keys',
  anthropic: 'https://console.anthropic.com/',
  openRouter: 'https://openrouter.ai/keys',
  google: 'https://aistudio.google.com/app/apikey',
  xai: 'https://console.x.ai/',
  deepseek: 'https://platform.deepseek.com/api_keys',
  moonshot: 'https://platform.moonshot.cn/console',
  dashscope: 'https://dashscope.aliyun.com/api-console/',
  wolframllmapp: 'https://llm-api.wolframalpha.com/',
};

export const apiKeyCommands = {
  setApiKey: 'texra.setApiKey',
  removeApiKey: 'texra.removeApiKey',
};

// Helper function to set API key for a specific provider
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
    await vscode.commands.executeCommand('texra.refreshApiKeyStatus');
    // Refresh both model and agent options (model availability may change)
    void vscode.commands.executeCommand('texra.refreshAllOptions');
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

export function registerApiKeyCommands(context: vscode.ExtensionContext) {
  // Command to set API key (accepts optional provider parameter)
  const setApiKeyCommand = vscode.commands.registerCommand(
    apiKeyCommands.setApiKey,
    async (provider?: ApiProvider) => {
      let selectedProvider = provider;
      const skipDialog = !!provider; // Skip dialog if provider was passed

      if (!selectedProvider) {
        // Show provider selection if no provider specified
        const providerItems =
          await SecretManager.getApiProviderQuickPickItems();
        const providerPick = await vscode.window.showQuickPick(providerItems, {
          placeHolder: 'Select API provider',
        });
        selectedProvider = providerPick?.provider;
      }

      if (!selectedProvider) {
        return;
      }

      await setApiKeyForProvider(selectedProvider, skipDialog);
    },
  );

  // Command to remove API key
  const removeApiKeyCommand = vscode.commands.registerCommand(
    apiKeyCommands.removeApiKey,
    async () => {
      const providerItems = await SecretManager.getApiProviderQuickPickItems();
      const providerPick = await vscode.window.showQuickPick(providerItems, {
        placeHolder: 'Select API provider to remove key',
      });

      const provider = providerPick?.provider;

      if (!provider) {
        return;
      }

      try {
        await SecretManager.delete(
          SecretManager.getApiKeySecretName(provider as ApiProvider),
        );
        vscode.window.showInformationMessage(
          `${provider} API key has been removed`,
        );
        await vscode.commands.executeCommand('texra.refreshApiKeyStatus');
        // Refresh both model and agent options (model availability may change)
        void vscode.commands.executeCommand('texra.refreshAllOptions');
        const any = await SecretManager.anyApiKeyExists();
        const view = await getMainWebview();
        view?.webview.postMessage({
          command: any
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
    },
  );

  context.subscriptions.push(setApiKeyCommand, removeApiKeyCommand);

  return {
    setApiKeyCommand,
    removeApiKeyCommand,
  };
}
