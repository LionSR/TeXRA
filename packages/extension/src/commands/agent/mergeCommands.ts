// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { getHelperModelName } from '@agent/runtime';
import { registerCommandEntries } from '@commands/_shared/registerCommands';
import { showLoggedMessageWithDocs } from '@frontend/ui/errorHandlingUtils';
import type { StateStore } from '@platform/interfaces';

const CHANNEL = 'MergeCommands';

export function registerMergeCommands(context: vscode.ExtensionContext): void {
  registerCommandEntries(context, [
    {
      id: 'texra.merge',
      handler: (baseFile: string, editedFile: string) =>
        handleMerge(context.globalState, baseFile, editedFile),
    },
  ]);
}

async function handleMerge(
  globalState: StateStore,
  baseFile: string,
  editedFile: string,
): Promise<void> {
  if (!baseFile || !editedFile) {
    await showLoggedMessageWithDocs(
      CHANNEL,
      'Both base file and edited file must be specified for merge operation',
      'intelligent-merge',
      'View Merge Docs',
    );
    return;
  }

  await vscode.commands.executeCommand('texra.execute', {
    agent: 'merge',
    model: getHelperModelName(globalState),
    inputFiles: [baseFile],
    editedFile,
  });
}
