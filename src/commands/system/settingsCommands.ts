// Third-party imports
import * as vscode from 'vscode';

// Local imports - utils
import { SETTINGS_QUERY } from '@utils/config';

export const settingsCommands = {
  openSettings: 'texra.openSettings',
};

export function registerSettingsCommands(context: vscode.ExtensionContext) {
  const openSettingsCommand = vscode.commands.registerCommand(
    settingsCommands.openSettings,
    () =>
      vscode.commands.executeCommand(
        'workbench.action.openSettings',
        SETTINGS_QUERY.EXTENSION,
      ),
  );

  context.subscriptions.push(openSettingsCommand);

  return { openSettingsCommand };
}
