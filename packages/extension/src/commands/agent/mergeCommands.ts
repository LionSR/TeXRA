// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { executeAgent } from '@agent/runtime/executeAgent';
import { getHelperModelName } from '@agent/runtime/helperModel';
import { extensionAgentRuntimeHost } from '@frontend/agentRuntime/extensionAgentRuntimeHost';
import { showLoggedMessageWithDocs } from '@frontend/ui/errorHandlingUtils';

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

  // Merge is a normal prompt-driven workflow agent (see merge.yaml); it runs
  // through the generic agent path with the original as the input file and the
  // partially-edited document as the edited file.
  await executeAgent(
    {
      agent: 'merge',
      model: model ?? getHelperModelName(),
      inputFiles: [baseFile ?? inputFile],
      editedFile,
    },
    undefined,
    { runtimeHost: extensionAgentRuntimeHost },
  );
}
