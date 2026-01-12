// Third-party imports
import * as vscode from 'vscode';

// Local imports - utils
import { SETTINGS_QUERY } from '@utils/config';

// Local imports - settings view
import { SettingsViewProvider } from '@settingsView/SettingsViewProvider';
import type { SettingsTab } from '@settingsView/schemas';

export const settingsCommands = {
  openSettings: 'texra.openSettings',
  openSettingsView: 'texra.openSettingsView',
  openModelsSettings: 'texra.openModelsSettings',
  openAgentsSettings: 'texra.openAgentsSettings',
};

// Store the provider instance for access from other modules
let settingsViewProviderInstance: SettingsViewProvider | null = null;

/** Get the SettingsViewProvider instance (available after registerSettingsCommands is called). */
export function getSettingsViewProvider(): SettingsViewProvider | null {
  return settingsViewProviderInstance;
}

export function registerSettingsCommands(context: vscode.ExtensionContext) {
  // Create settings view provider
  settingsViewProviderInstance = new SettingsViewProvider(context);

  // Open native VS Code settings (legacy)
  const openSettingsCommand = vscode.commands.registerCommand(
    settingsCommands.openSettings,
    async () => {
      // Open VS Code settings with TeXRA filter
      await vscode.commands.executeCommand(
        'workbench.action.openSettings',
        SETTINGS_QUERY.EXTENSION,
      );
    },
  );

  // Open Settings View (unified panel)
  const openSettingsViewCommand = vscode.commands.registerCommand(
    settingsCommands.openSettingsView,
    async (tab?: SettingsTab) => {
      await settingsViewProviderInstance?.showSettingsView(tab);
    },
  );

  // Open Settings View directly to Models tab
  const openModelsSettingsCommand = vscode.commands.registerCommand(
    settingsCommands.openModelsSettings,
    async () => {
      await settingsViewProviderInstance?.showSettingsView('models');
    },
  );

  // Open Settings View directly to Agents tab
  const openAgentsSettingsCommand = vscode.commands.registerCommand(
    settingsCommands.openAgentsSettings,
    async () => {
      await settingsViewProviderInstance?.showSettingsView('agents');
    },
  );

  context.subscriptions.push(
    openSettingsCommand,
    openSettingsViewCommand,
    openModelsSettingsCommand,
    openAgentsSettingsCommand,
  );

  return {
    openSettingsCommand,
    openSettingsViewCommand,
    openModelsSettingsCommand,
    openAgentsSettingsCommand,
    settingsViewProvider: settingsViewProviderInstance,
  };
}
