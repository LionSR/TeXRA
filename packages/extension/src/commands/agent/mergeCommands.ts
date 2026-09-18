// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { getHelperModelName } from '@agent/runtime';
import { registerCommandEntries } from '@commands/_shared/registerCommands';
import { showLoggedMessageWithDocs } from '@frontend/ui/errorHandlingUtils';
import type { StateStore } from '@platform/interfaces';
import type { ProcessRuntime } from '@platform/processRuntime';

const CHANNEL = 'MergeCommands';

export function registerMergeCommands(
  context: vscode.ExtensionContext,
  globalState: StateStore,
  runtime: ProcessRuntime,
): void {
  registerCommandEntries(context, [
    {
      id: 'texra.merge',
      handler: (baseFile: string, editedFile: string) =>
        handleMerge(globalState, baseFile, editedFile, runtime),
    },
  ]);
}

async function handleMerge(
  globalState: StateStore,
  baseFile: string,
  editedFile: string,
  runtime: ProcessRuntime,
): Promise<void> {
  if (!baseFile || !editedFile) {
    await runtime.runPromise(
      showLoggedMessageWithDocs(
        CHANNEL,
        'Both base file and edited file must be specified for merge operation',
        'intelligent-merge',
        'View Merge Docs',
      ),
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
