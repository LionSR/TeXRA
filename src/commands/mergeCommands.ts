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

  const model = getConfig('merge.defaultModel', 'sonnet37');
  const fileToUse = baseFile || inputFile;

  try {
    await executeMergeAgent(model, fileToUse, editedFile, context);
  } catch (err) {
    throw err;
  }
}

export const mergeCommands = {
  handleMerge,
};
