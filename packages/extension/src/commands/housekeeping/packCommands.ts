// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { showLoggedMessage } from '@frontend/ui/errorHandlingUtils';
import {
  runPackSingle,
  runPackMultiple,
  runPackRunDir,
} from '@housekeeping';
import {
  mergeRunDirAndWorkspaceResult,
  type FileOpResult,
} from '@shared/schemas/opResults';
import { WorkspaceFS } from '@utils/files/workspaceFS';
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
  const { agent, model, inputFile, outputFiles, executionId } = config;

  const runWorkspacePack = (): Promise<FileOpResult> =>
    outputFiles.length > 0
      ? runPackMultiple(model, inputFile, agent, outputFiles)
      : runPackSingle(model, inputFile, agent);

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
  // Exactly addressed (#9590 A3): clear only the tab the caller selected.
  // Config-only invocations have no stream context and clear nothing.
  if (!config.skipProgressViewClear && config.streamId) {
    emitClearMissingOutputs(config.streamId);
  }
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
