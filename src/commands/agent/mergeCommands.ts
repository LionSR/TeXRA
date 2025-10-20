// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '@logger/logUtils';

// Local imports - errors
import {
  showLoggedMessageWithDocs,
  showLoggedErrorMessage,
} from '@common/errors/errorHandlingUtils';

// Local imports - agent
import { executeMergeAgent } from '@agent/runtime/executeAgent';

// Local imports - utilities
import { getConfig } from '@utils/config';

export function registerMergeCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'texra.merge',
      (inputFile: string, baseFile: string, editedFile: string) =>
        handleMerge(context, inputFile, baseFile, editedFile),
    ),
  );
}

const CHANNEL = 'MergeCommands';
logger.initialize(CHANNEL);

async function handleMerge(
  context: vscode.ExtensionContext,
  inputFile: string,
  baseFile: string,
  editedFile: string,
) {
  if (!editedFile || (!baseFile && !inputFile)) {
    await showLoggedMessageWithDocs(
      CHANNEL,
      'Both input file and edited file must be specified for merge operation',
      'intelligent-merge',
      'View Merge Docs',
    );
    return;
  }

  const model = getConfig('merge.defaultModel', 'sonnet37');
  const fileToUse = baseFile || inputFile;

  try {
    await executeMergeAgent(model, fileToUse, editedFile);
  } catch (err) {
    // Log the error before re-throwing
    await showLoggedErrorMessage(
      'MergeCommands',
      'Merge operation failed',
      err,
    );
    throw err;
  }
}

export const mergeCommands = {
  handleMerge,
};
