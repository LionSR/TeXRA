// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { showLoggedMessage } from '@frontend/ui/errorHandlingUtils';
import {
  runCleanSingle,
  runCleanMultiple,
  runCleanRunDir,
} from '@housekeeping';
import * as logger from '@logger/logUtils';
import {
  mergeRunDirAndWorkspaceResult,
  type FileOpResult,
} from '@shared/schemas/opResults';
import { type CleanConfig } from './fileOpSchemas';
import { emitClearMissingOutputs } from './streamEventUtils';

const CHANNEL = 'cleanCommands';

function showCleanResult(result: FileOpResult, inputFile: string): void {
  switch (result.status) {
    case 'success':
      vscode.window.showInformationMessage(`Cleanup complete for ${inputFile}`);
      break;
    case 'noFiles':
      vscode.window.showInformationMessage(
        `No files found to clean for ${inputFile}`,
      );
      break;
    case 'missingParams':
      void showLoggedMessage(CHANNEL, 'Select an input file before cleaning.');
      break;
    case 'error':
      void vscode.window.showErrorMessage(
        `Error during cleanup: ${result.error}`,
      );
      break;
  }
}

export async function handleCleanSingle(
  inputFile: string,
  agent: string,
  model: string,
): Promise<void> {
  const result = await runCleanSingle(model, inputFile, agent);
  showCleanResult(result, inputFile);
}

export async function handleCleanMultiple(
  inputFile: string,
  agent: string,
  model: string,
  inputFiles: string[] = [],
): Promise<void> {
  if (inputFiles.length > 0) {
    logger.debug(CHANNEL, `Additional files: ${inputFiles.join(', ')}`);
  }
  const result =
    inputFiles.length > 0
      ? await runCleanMultiple(model, inputFile, agent, inputFiles)
      : await runCleanSingle(model, inputFile, agent);
  showCleanResult(result, inputFile);
  // No missing-outputs clear: these invocations have no stream context, and
  // configuration-based fan-out to look-alike tabs was removed (#9590 A3).
}

export async function handleClean(config: CleanConfig): Promise<void> {
  const { agent, model, inputFile, outputFiles, executionId } = config;

  logger.debug(
    CHANNEL,
    `Clean command called with config: ${JSON.stringify(config)}`,
  );

  // Toolbar-driven invocations pass an executionId: delete the run's runDir
  // AND sweep the workspace. The workspace scan is a no-op for new runs
  // (their outputs live only inside the runDir), but it catches legacy
  // runs whose outputs still sit beside the source — those runs also
  // produce a runDir via `ensureRunDir`, so keying solely off
  // `runCleanRunDir` returning `success` leaves the real artifacts behind.
  const runWorkspaceClean = (): Promise<FileOpResult> =>
    outputFiles.length > 0
      ? runCleanMultiple(model, inputFile, agent, outputFiles)
      : runCleanSingle(model, inputFile, agent);

  let result: FileOpResult;
  if (executionId) {
    const runDirResult = await runCleanRunDir(executionId);
    const workspaceResult = await runWorkspaceClean();
    result = mergeRunDirAndWorkspaceResult(runDirResult, workspaceResult);
  } else {
    result = await runWorkspaceClean();
  }
  showCleanResult(result, inputFile);
  // Exactly addressed (#9590 A3): clear only the tab the caller selected.
  // Config-only invocations have no stream context and clear nothing.
  if (!config.skipProgressViewClear && config.streamId) {
    emitClearMissingOutputs(config.streamId);
  }
}
