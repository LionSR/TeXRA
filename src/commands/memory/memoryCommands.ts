// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { MemoryViewProvider } from '@memoryView/MemoryViewProvider';

export const memoryCommands = {
  showMemory: 'texra.showMemory',
};

export function registerMemoryCommands(context: vscode.ExtensionContext): void {
  const memoryViewProvider = new MemoryViewProvider(context);

  context.subscriptions.push(
    vscode.commands.registerCommand(memoryCommands.showMemory, () =>
      memoryViewProvider.showMemoryView(),
    ),
  );
}
