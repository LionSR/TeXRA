// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { showLoggedMessage } from '@frontend/ui/errorHandlingUtils';
import {
  runPack,
  runPackSingle,
  runPackMultiple,
  runPackRunDir,
} from '@housekeeping';
import {
  mergeRunDirAndWorkspaceResult,
  type FileOpResult,
} from '@shared/schemas/opResults';
import { WorkspaceFS } from '@utils/files';
import { type PackConfig } from './fileOpSchemas';
import { emitClearMissingOutputs } from './streamEventUtils';

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
      void showLoggedMessage(CHANNEL, 'Missing required parameters for pack');
      break;
    case 'error':
      void vscode.window.showErrorMessage(
        `Error during packing: ${result.error}`,
      );
      break;
  }
}

export async function handlePack(config: PackConfig): Promise<void> {
  const { agent, model, inputFile, outputFiles, executionId } = config;

  const runWorkspacePack = (): Promise<FileOpResult> =>
    runPack(model, inputFile, agent, outputFiles);

  // Toolbar-driven invocations pass an executionId: snapshot the runDir
  // AND the workspace. The workspace pass is a no-op for new runs (their
  // outputs live only inside the runDir), but it catches legacy runs
  // whose outputs still sit beside the source — those runs also
  // produce a runDir via `ensureRunDir`, so keying solely off
  // `runPackRunDir` returning non-noFiles skips real workspace
  // artifacts and would produce an empty snapshot.
  let result: FileOpResult;
  if (executionId) {
    const runDirResult = await runPackRunDir(
      executionId,
      agent,
      model,
      inputFile,
    );
    const workspaceResult = await runWorkspacePack();
    result = mergeRunDirAndWorkspaceResult(runDirResult, workspaceResult);
  } else {
    result = await runWorkspacePack();
  }
  showPackResult(result, inputFile);
  emitClearMissingOutputs(config);
}

export async function handlePackSingle(
  inputFile: string,
  agent: string,
  model: string,
): Promise<void> {
  const result = await runPackSingle(model, inputFile, agent);
  showPackResult(result, inputFile);
  emitClearMissingOutputs({ agent, model, inputFile, outputFiles: [] });
}

export async function handlePackMultiple(
  inputFile: string,
  agent: string,
  model: string,
  inputFiles: string[] = [],
): Promise<void> {
  const result = await runPackMultiple(model, inputFile, agent, inputFiles);
  showPackResult(result, inputFile);
  emitClearMissingOutputs({
    agent,
    model,
    inputFile,
    outputFiles: inputFiles,
  });
}
