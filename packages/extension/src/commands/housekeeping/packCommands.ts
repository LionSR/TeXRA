// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { showLoggedMessage } from '@frontend/ui/errorHandlingUtils';
import { runPackSingle, runPackMultiple } from '@housekeeping/pack';
import { runPackRunDir } from '@housekeeping/runDirOps';

import type { FileOpResult } from '@shared/schemas';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { type PackConfig } from './fileOpSchemas';
import { runFileOp } from './fileOpRunner';

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

export function handlePack(config: PackConfig): Promise<void> {
  return runFileOp(config, {
    runSingle: runPackSingle,
    runMultiple: runPackMultiple,
    runRunDir: runPackRunDir,
    showResult: showPackResult,
  });
}
