// Third-party imports
import * as vscode from 'vscode';

import { showLoggedMessage } from '@frontend/ui/errorHandlingUtils';
import { SettingsViewProvider } from '@settingsView/SettingsViewProvider';

const CHANNEL = 'settingsCommands';

let settingsViewProvider: SettingsViewProvider | null = null;

export function initializeSettingsViewProvider(
  context: vscode.ExtensionContext,
): SettingsViewProvider {
  if (!settingsViewProvider) {
    settingsViewProvider = new SettingsViewProvider(context);
  }
  return settingsViewProvider;
}

export async function showSettingsView(): Promise<void> {
  if (!settingsViewProvider) {
    void showLoggedMessage(
      CHANNEL,
      'Settings view not initialized. Please reload the extension.',
    );
    return;
  }
  await settingsViewProvider.showSettingsView();
}

/** Initialize the settings provider before registry-backed commands use it. */
export function registerSettingsViewCommands(
  context: vscode.ExtensionContext,
): void {
  initializeSettingsViewProvider(context);
}
