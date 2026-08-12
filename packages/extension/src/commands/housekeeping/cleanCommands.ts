// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { showLoggedMessage } from '@frontend/ui/errorHandlingUtils';
import { runCleanSingle, runCleanMultiple } from '@housekeeping/clean';
import { runCleanRunDir } from '@housekeeping/runDirOps';
import * as logger from '@logger/logUtils';
import { type FileOpResult } from '@shared/schemas/opResults';
import { type CleanConfig } from './fileOpSchemas';
import { runFileOp } from './fileOpRunner';

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
  logger.debug(
    CHANNEL,
    `Clean command called with config: ${JSON.stringify(config)}`,
  );
  await runFileOp(config, {
    runSingle: runCleanSingle,
    runMultiple: runCleanMultiple,
    runRunDir: (executionId) => runCleanRunDir(executionId),
    showResult: showCleanResult,
  });
}
