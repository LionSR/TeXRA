// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { getHelperModelName } from '@agent/runtime/helperModelName';
import { registerCommandEntries } from '@commands/_shared/registerCommands';
import { showLoggedMessageWithDocs } from '@frontend/ui/errorHandlingUtils';

const CHANNEL = 'MergeCommands';

export function registerMergeCommands(context: vscode.ExtensionContext): void {
  registerCommandEntries(context, [
    { id: 'texra.merge', handler: handleMerge },
  ]);
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

  await vscode.commands.executeCommand('texra.execute', {
    agent: 'merge',
    model: model ?? getHelperModelName(),
    inputFiles: [baseFile ?? inputFile],
    editedFile,
  });
}
