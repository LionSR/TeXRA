// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { executeMergeAgent } from '@agent/runtime/executeAgent';
import { showLoggedMessageWithDocs } from '@common/errors';
import { getConfig } from '@utils/config';

const CHANNEL = 'MergeCommands';

export function registerMergeCommands(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('texra.merge', handleMerge),
  );
}

async function handleMerge(
  inputFile: string,
  baseFile: string,
  editedFile: string,
  model?: string,
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

  await executeMergeAgent(
    model ?? getConfig('texra.merge.defaultModel', 'gemini3f'),
    baseFile ?? inputFile,
    editedFile,
  );
}
