import * as vscode from 'vscode';
import { AgentHistoryViewProvider } from '../history/AgentHistoryViewProvider';

export const historyCommands = {
  showHistory: 'coauthor.showAgentHistory',
};

/**
 * Register the commands related to agent execution history
 */
export function registerHistoryCommands(context: vscode.ExtensionContext) {
  // Create history view provider
  const historyViewProvider = new AgentHistoryViewProvider(context);

  // Register show history command
  const showHistoryCommand = vscode.commands.registerCommand(
    historyCommands.showHistory,
    async () => {
      await historyViewProvider.showHistoryView();
    },
  );

  // Register webview provider for possible sidebar integration
  const historyWebviewProvider = vscode.window.registerWebviewViewProvider(
    AgentHistoryViewProvider.viewType,
    historyViewProvider,
  );

  // Add subscriptions
  context.subscriptions.push(showHistoryCommand, historyWebviewProvider);

  return {
    historyViewProvider,
  };
}
