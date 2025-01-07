// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports - utilities
import { getConfig } from '../frontend-utils/commonUtils';

// Local imports - agent
import { executeMergeAgent } from '../agent/executeAgent';

const CHANNEL = 'Commands';
logger.initialize(CHANNEL);

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
    // If direct execution fails, fall back to terminal execution
    logger.warn(
      CHANNEL,
      `Direct execution failed, falling back to terminal: ${error}`,
    );

    const terminalName = `Merge@${model}`;
    const terminalNew = vscode.window.createTerminal(terminalName);
    terminalNew.show();
    terminalNew.sendText(
      `coauthor merge --inputFile="${fileToUse}" --editedFile="${editedFile}" --model=${model}`,
    );
  }
}

export const mergeCommands = {
  handleMerge,
};
