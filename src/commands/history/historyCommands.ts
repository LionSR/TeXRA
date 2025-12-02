// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { type AgentConfig } from '@agent/core/AgentConfig';
import { HistoryViewProvider } from '@historyView/HistoryViewProvider';
import { AgentHistoryManager } from '@historyView/managers';

export const historyCommands = {
  showHistory: 'texra.showAgentHistory',
  addToHistory: 'texra.history.addToHistory',
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
    async () => {
      await historyViewProvider.showHistoryView();
    },
  );

  // Register add to history command (used by executeCommand to decouple from historyView)
  const addToHistoryCommand = vscode.commands.registerCommand(
    historyCommands.addToHistory,
    async (config: AgentConfig) => {
      return AgentHistoryManager.addToHistory(config);
    },
  );

  // Add subscriptions
  context.subscriptions.push(showHistoryCommand, addToHistoryCommand);

  return {
    historyViewProvider,
  };
}
