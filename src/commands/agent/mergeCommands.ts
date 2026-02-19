// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { executeMergeAgent } from '@agent/runtime/executeAgent';
import { showLoggedMessageWithDocs } from '@common/errors';
import { GlobalStateKey, globalSM } from '@common/state';
import { DEFAULT_HELPER_MODEL } from '@shared/constants/providers';

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
    model ?? globalSM.get<string>(GlobalStateKey.HELPER_MODEL, DEFAULT_HELPER_MODEL),
    baseFile ?? inputFile,
    editedFile,
  );
}
