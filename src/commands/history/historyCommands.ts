// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { HistoryViewProvider } from '@historyView/HistoryViewProvider';

export const historyCommands = {
  showHistory: 'texra.showAgentHistory',
};

/**
 * Register the commands related to agent execution history
 */
export function registerHistoryCommands(context: vscode.ExtensionContext) {
  // Create history view provider
  const historyViewProvider = new HistoryViewProvider(context);

  // Register show history command
  const showHistoryCommand = vscode.commands.registerCommand(
    historyCommands.showHistory,
    () => historyViewProvider.showHistoryView(),
  );

  // Add subscriptions
  context.subscriptions.push(showHistoryCommand);
}
