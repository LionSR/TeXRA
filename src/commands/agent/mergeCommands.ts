// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { executeMergeAgent } from '@agent/runtime/executeAgent';
import { showLoggedMessageWithDocs } from '@common/errors';
import * as logger from '@logger/logUtils';
import { getConfig } from '@utils/config';

const CHANNEL = 'MergeCommands';
logger.initialize(CHANNEL);

export function registerMergeCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'texra.merge',
      (inputFile: string, baseFile: string, editedFile: string) =>
        handleMerge(inputFile, baseFile, editedFile),
    ),
  );
}

async function handleMerge(
  inputFile: string,
  baseFile: string,
  editedFile: string,
): Promise<void> {
  if (!editedFile || (!baseFile && !inputFile)) {
    await showLoggedMessageWithDocs(
      CHANNEL,
      'Both input file and edited file must be specified for merge operation',
      'intelligent-merge',
      'View Merge Docs',
    );
    return;
  }

  const model = getConfig('texra.merge.defaultModel', 'sonnet37');
  const fileToUse = baseFile ?? inputFile;

  await executeMergeAgent(model, fileToUse, editedFile);
}

export const mergeCommands = {
  handleMerge,
};
