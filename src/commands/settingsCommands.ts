import * as vscode from 'vscode';

export const settingsCommands = {
  openSettings: 'texra.openSettings',
};

export function registerSettingsCommands(context: vscode.ExtensionContext) {
  const openSettingsCommand = vscode.commands.registerCommand(
    settingsCommands.openSettings,
    async () => {
      // Open VS Code settings with TeXRA filter
      await vscode.commands.executeCommand(
        'workbench.action.openSettings',
        '@ext:texra-ai.texra',
      );
    },
  );

  context.subscriptions.push(openSettingsCommand);

  return { openSettingsCommand };
}
