import * as vscode from 'vscode';
import {
  API_PROVIDERS,
  ApiProvider,
  getApiKeySecretName,
  setSecret,
  deleteSecret,
} from '../utils/secretUtils';

export const apiKeyCommands = {
  setApiKey: 'coauthor.setApiKey',
  removeApiKey: 'coauthor.removeApiKey',
};

export function registerApiKeyCommands(context: vscode.ExtensionContext) {
  // Command to set API key
  const setApiKeyCommand = vscode.commands.registerCommand(
    apiKeyCommands.setApiKey,
    async () => {
      // First select the provider
      const provider = await vscode.window.showQuickPick(API_PROVIDERS, {
        placeHolder: 'Select API provider',
      });

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
        await setSecret(getApiKeySecretName(provider as ApiProvider), apiKey);
        vscode.window.showInformationMessage(
          `${provider} API key has been set`,
        );
      } catch (error) {
        vscode.window.showErrorMessage(
          `Failed to set ${provider} API key: ${error}`,
        );
      }
    },
  );

  // Command to remove API key
  const removeApiKeyCommand = vscode.commands.registerCommand(
    apiKeyCommands.removeApiKey,
    async () => {
      const provider = await vscode.window.showQuickPick(API_PROVIDERS, {
        placeHolder: 'Select API provider to remove key',
      });

      if (!provider) {
        return;
      }

      try {
        await deleteSecret(getApiKeySecretName(provider as ApiProvider));
        vscode.window.showInformationMessage(
          `${provider} API key has been removed`,
        );
      } catch (error) {
        vscode.window.showErrorMessage(
          `Failed to remove ${provider} API key: ${error}`,
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
