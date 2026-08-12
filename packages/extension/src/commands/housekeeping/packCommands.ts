// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { showLoggedMessage } from '@frontend/ui/errorHandlingUtils';
import { runPackSingle, runPackMultiple } from '@housekeeping/pack';
import { runPackRunDir } from '@housekeeping/runDirOps';
import { type FileOpResult } from '@shared/schemas/opResults';
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

export async function handlePack(config: PackConfig): Promise<void> {
  await runFileOp(config, {
    runSingle: runPackSingle,
    runMultiple: runPackMultiple,
    runRunDir: (executionId, agent, model, inputFile) =>
      runPackRunDir(executionId, agent, model, inputFile),
    showResult: showPackResult,
  });
}

export async function handlePackSingle(
  inputFile: string,
  agent: string,
  model: string,
): Promise<void> {
  const result = await runPackSingle(model, inputFile, agent);
  showPackResult(result, inputFile);
  // No missing-outputs clear: these invocations have no stream context, and
  // configuration-based fan-out to look-alike tabs was removed (#9590 A3).
}

export async function handlePackMultiple(
  inputFile: string,
  agent: string,
  model: string,
  inputFiles: string[] = [],
): Promise<void> {
  const result = await runPackMultiple(model, inputFile, agent, inputFiles);
  showPackResult(result, inputFile);
}
