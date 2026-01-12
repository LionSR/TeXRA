// Third-party imports
import * as vscode from 'vscode';

export const memoryCommands = {
  showMemory: 'texra.showMemory',
};

/**
 * Register the commands related to memory view.
 * Legacy command that redirects to the unified Settings View.
 */
export function registerMemoryCommands(context: vscode.ExtensionContext) {
  // Register show memory command - redirects to Settings View memory tab
  const showMemoryCommand = vscode.commands.registerCommand(
    memoryCommands.showMemory,
    async () => {
      await vscode.commands.executeCommand('texra.openSettingsView', 'memory');
    },
  );

  // Add subscriptions
  context.subscriptions.push(showMemoryCommand);

  return {};
}
