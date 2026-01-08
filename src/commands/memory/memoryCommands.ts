// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { MemoryViewProvider } from '@memoryView/MemoryViewProvider';

export const memoryCommands = {
  showMemory: 'texra.showMemory',
};

/**
 * Register the commands related to memory view
 */
export function registerMemoryCommands(context: vscode.ExtensionContext) {
  // Create memory view provider
  const memoryViewProvider = new MemoryViewProvider(context);

  // Register show memory command
  const showMemoryCommand = vscode.commands.registerCommand(
    memoryCommands.showMemory,
    async () => {
      await memoryViewProvider.showMemoryView();
    },
  );

  // Add subscriptions
  context.subscriptions.push(showMemoryCommand);

  return {
    memoryViewProvider,
  };
}
