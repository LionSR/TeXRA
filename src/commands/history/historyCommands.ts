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
export function registerHistoryCommands(
  context: vscode.ExtensionContext,
): void {
  const historyViewProvider = new HistoryViewProvider(context);

  context.subscriptions.push(
    vscode.commands.registerCommand(
      historyCommands.showHistory,
      () => historyViewProvider.showHistoryView(),
    ),
  );
}
