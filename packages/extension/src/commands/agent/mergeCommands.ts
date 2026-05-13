// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { executeMergeAgent } from '@agent/runtime/executeAgent';
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

  await executeMergeAgent(
    model ?? getHelperModelName(),
    baseFile ?? inputFile,
    editedFile,
    extensionAgentRuntimeHost,
  );
}
