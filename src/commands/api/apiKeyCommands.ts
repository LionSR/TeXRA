// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { SecretManager, ApiProvider } from '@frontend/secretManager';

export const apiKeyCommands = {
  setApiKey: 'texra.setApiKey',
  removeApiKey: 'texra.removeApiKey',
};

export function registerApiKeyCommands(context: vscode.ExtensionContext) {
  // Command to set API key
  const setApiKeyCommand = vscode.commands.registerCommand(
    apiKeyCommands.setApiKey,
    async () => {
      // First select the provider
      const providerItems = await SecretManager.getApiProviderQuickPickItems();
      const providerPick = await vscode.window.showQuickPick(providerItems, {
        placeHolder: 'Select API provider',
      });

      const provider = providerPick?.provider;

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
          SecretManager.getApiKeySecretName(provider as ApiProvider),
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
