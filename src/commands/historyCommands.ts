import * as vscode from 'vscode';
import { AgentHistoryViewProvider } from '../historyView/AgentHistoryViewProvider';

export const historyCommands = {
  showHistory: 'texra.showAgentHistory',
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

  // Add subscriptions
  context.subscriptions.push(showHistoryCommand);

  return {
    historyViewProvider,
  };
}
