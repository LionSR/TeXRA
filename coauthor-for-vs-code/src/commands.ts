import * as vscode from 'vscode';
import { registerFileSelectionCommands } from './commands/fileSelection';
import { registerLatexDiffCommands } from './commands/latexDiff';
import { registerGitCommands } from './commands/gitCommands';
import { registerPackCommands } from './commands/packCommands';
import { registerMergeCommands } from './commands/mergeCommands';
import { registerExecuteCommand } from './commands/executeCommand';
import { CoAuthorViewProvider } from './viewProvider';
import { initializeLogging } from './utils/logUtils';

const CHANNEL = 'Commands';
initializeLogging(CHANNEL);

/**
 * Register all extension commands
 * Commands are organized into logical groups in separate modules
 */
export function registerCommands(context: vscode.ExtensionContext) {
  // Register command groups from separate modules
  const registeredCommands = {
    fileSelection: registerFileSelectionCommands(context),
    latexDiff: registerLatexDiffCommands(context),
    git: registerGitCommands(context),
    pack: registerPackCommands(context),
    merge: registerMergeCommands(context),
    execute: registerExecuteCommand(context),
  };

  // Register webview provider
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'coauthor.chatView',
      new CoAuthorViewProvider(context),
    ),
  );

  return registeredCommands;
}

// Add exports for the command modules
export { fileSelectionCommands } from './commands/fileSelection';
export { latexDiffCommands } from './commands/latexDiff';
export { gitCommands } from './commands/gitCommands';
export { packCommands } from './commands/packCommands';
export { mergeCommands } from './commands/mergeCommands';
export { executeCommand } from './commands/executeCommand';
