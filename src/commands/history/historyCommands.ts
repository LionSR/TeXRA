// Third-party imports
import * as vscode from 'vscode';

export const historyCommands = {
  showHistory: 'texra.showAgentHistory',
};

/**
 * Register the commands related to agent execution history.
 * Legacy command that redirects to the unified Settings View.
 */
export function registerHistoryCommands(context: vscode.ExtensionContext) {
  // Register show history command - redirects to Settings View history tab
  const showHistoryCommand = vscode.commands.registerCommand(
    historyCommands.showHistory,
    async () => {
      await vscode.commands.executeCommand('texra.openSettingsView', 'history');
    },
  );

  // Add subscriptions
  context.subscriptions.push(showHistoryCommand);

  return {};
}
