// Third-party imports
import * as vscode from 'vscode';

// Local imports - utilities
import { getConfig } from '../frontend-utils/commonUtils';

// Local imports - agent
import { executeMergeAgent } from '../agent/executeAgent';

export function registerMergeCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'coauthor.merge',
      (inputFile: string, baseFile: string, editedFile: string) =>
        handleMerge(context, inputFile, baseFile, editedFile),
    ),
  );
}

async function handleMerge(
  context: vscode.ExtensionContext,
  inputFile: string,
  baseFile: string,
  editedFile: string,
) {
  if (!editedFile || (!baseFile && !inputFile)) {
    const errorMsg =
      'Both input file and edited file must be specified for merge operation';
    vscode.window.showErrorMessage(errorMsg);
    return;
  }

  const model = getConfig('merge.defaultModel', 'sonnet+');
  const fileToUse = baseFile || inputFile;

  try {
    await executeMergeAgent(model, fileToUse, editedFile, context);
  } catch (error) {
    const allowTerminalFallback = getConfig<boolean>(
      'execution.allowTerminalFallback',
      false,
    );
    if (!allowTerminalFallback) {
      throw error;
    }
    // If direct execution fails and terminal fallback is allowed, fall back to terminal execution
    vscode.window.showWarningMessage(
      `Direct execution failed, falling back to terminal: ${error}`,
    );

    const terminalName = `Merge@${model}`;
    const terminalNew = vscode.window.createTerminal(terminalName);
    terminalNew.show();

    let command = `coauthor merge --inputFile="${fileToUse}" --editedFile="${editedFile}" --model=${model}`;

    // Add useOpenRouter from VS Code settings if enabled
    if (getConfig<boolean>('useOpenRouter', false)) {
      command += ' --useOpenRouter';
    }

    terminalNew.sendText(command);
  }
}

export const mergeCommands = {
  handleMerge,
};
