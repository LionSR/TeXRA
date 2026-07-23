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
import type { FileOpResult } from '@shared/schemas/opResults';
import {
  mergeRunDirAndWorkspaceResult,
  type CleanConfig,
} from './fileOpSchemas';
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
      void showLoggedMessage(CHANNEL, 'Missing required parameters for clean');
      break;
    case 'error':
      void vscode.window.showErrorMessage(
        `Error during cleanup: ${result.error}`,
      );
      break;
  }
}

// Shared backing for the single- and multiple-file clean commands. Mirrors
// `runWorkspaceClean` in `handleClean`: an empty `outputFiles` list cleans the
// input alone, a non-empty list also sweeps the extra files.
async function runCleanCommand(
  inputFile: string,
  agent: string,
  model: string,
  outputFiles: string[],
): Promise<void> {
  if (outputFiles.length > 0) {
    logger.debug(CHANNEL, `Additional files: ${outputFiles.join(', ')}`);
  }

  const result =
    outputFiles.length > 0
      ? await runCleanMultiple(model, inputFile, agent, outputFiles)
      : await runCleanSingle(model, inputFile, agent);
  showCleanResult(result, inputFile);
  emitClearMissingOutputs({
    streamConfig: {
      agent,
      model,
      inputFile,
      outputFiles,
    },
  });
}

export async function handleCleanSingle(
  inputFile: string,
  agent: string,
  model: string,
): Promise<void> {
  await runCleanCommand(inputFile, agent, model, []);
}

export async function handleCleanMultiple(
  inputFile: string,
  agent: string,
  model: string,
  inputFiles: string[] = [],
): Promise<void> {
  await runCleanCommand(inputFile, agent, model, inputFiles);
}

export async function handleClean(config: CleanConfig): Promise<void> {
  const {
    agent,
    model,
    inputFile,
    outputFiles,
    streamId,
    executionId,
    skipProgressViewClear,
  } = config;

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

  if (!skipProgressViewClear) {
    emitClearMissingOutputs(
      streamId
        ? { streamIdOverride: streamId }
        : {
            streamConfig: {
              agent,
              model,
              inputFile,
              outputFiles,
            },
          },
    );
  }
}
