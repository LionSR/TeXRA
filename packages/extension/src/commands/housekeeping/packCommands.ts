// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { showLoggedMessage } from '@frontend/ui/errorHandlingUtils';
import { runPackSingle, runPackMultiple } from '@housekeeping/pack';
import { runPackRunDir } from '@housekeeping/runDirOps';

import {
  mergeRunDirAndWorkspaceResult,
  type FileOpResult,
} from '@shared/schemas';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { type PackConfig } from './fileOpSchemas';

const CHANNEL = 'packCommands';

function showPackResult(result: FileOpResult, inputFile: string): void {
  switch (result.status) {
    case 'success': {
      const folder = result.outputFolder;
      if (!folder) return;
      vscode.window
        .showInformationMessage(`Files packed into ${folder}`, 'Open Folder')
        .then((sel) => {
          if (sel === 'Open Folder') {
            void vscode.commands.executeCommand(
              'revealFileInOS',
              vscode.Uri.file(WorkspaceFS.fullPath(folder)),
            );
          }
        });
      break;
    }
    case 'noFiles':
      vscode.window.showInformationMessage(
        `No files found to pack for ${inputFile}`,
      );
      break;
    case 'missingParams':
      void showLoggedMessage(CHANNEL, 'Select an input file before packing.');
      break;
    case 'error':
      void vscode.window.showErrorMessage(
        `Error during packing: ${result.error}`,
      );
      break;
  }
}

export async function handlePack(config: PackConfig): Promise<void> {
  const { agent, model, inputFile, outputFiles, runId } = config;
  const packWorkspace = (): Promise<FileOpResult> =>
    outputFiles.length > 0
      ? runPackMultiple(model, inputFile, agent, outputFiles)
      : runPackSingle(model, inputFile, agent);

  // Toolbar invocations pass a runId: pack the run's storage AND the source
  // document's own files beside it in the workspace.
  const result = runId
    ? mergeRunDirAndWorkspaceResult(
        await runPackRunDir(runId, agent, model, inputFile),
        await packWorkspace(),
      )
    : await packWorkspace();
  showPackResult(result, inputFile);
}
