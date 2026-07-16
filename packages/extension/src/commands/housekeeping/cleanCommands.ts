// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { registerCommands } from '@commands/_shared/registerCommands';
import {
  parseWithErrorDisplay,
  showLoggedMessage,
} from '@frontend/ui/errorHandlingUtils';
import {
  runCleanSingle,
  runCleanMultiple,
  runCleanRunDir,
} from '@housekeeping';
import * as logger from '@logger/logUtils';
import type { FileOpResult } from '@shared/schemas/opResults';
import {
  FileOpParamsSchema,
  fileOpConfigFields,
  mergeRunDirAndWorkspaceResult,
} from './fileOpSchemas';
import { emitClearMissingOutputs } from './streamEventUtils';

const CHANNEL = 'cleanCommands';
logger.initialize(CHANNEL);

const CleanConfigSchema = FileOpParamsSchema.extend(fileOpConfigFields);

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

export function registerCleanCommands(context: vscode.ExtensionContext): void {
  // `texra.cleanOutput` and `texra.cleanBuild` are registered through
  // `extensionCommandSurface` so the dispatch path matches the desktop
  // registry (see #3771). The remaining clean commands take typed
  // arguments and stay on per-command registration for now.
  registerCommands(context, [
    { id: 'texra.clean', handler: handleClean },
    { id: 'texra.cleanSingle', handler: handleCleanSingle },
    { id: 'texra.cleanMultiple', handler: handleCleanMultiple },
  ]);
}

// Shared backing for the single- and multiple-file clean commands. Mirrors
// `runWorkspaceClean` in `handleClean`: an empty `outputFiles` list cleans the
// input alone, a non-empty list also sweeps the extra files.
async function runCleanCommand(
  inputFile: string,
  agent: string,
  model: string,
  label: string,
  outputFiles: string[],
): Promise<void> {
  const data = await parseWithErrorDisplay(
    CHANNEL,
    FileOpParamsSchema,
    { inputFile, agent, model },
    label,
  );
  if (!data) return;

  if (outputFiles.length > 0) {
    logger.debug(CHANNEL, `Additional files: ${outputFiles.join(', ')}`);
  }

  const result =
    outputFiles.length > 0
      ? await runCleanMultiple(
          data.model,
          data.inputFile,
          data.agent,
          outputFiles,
        )
      : await runCleanSingle(data.model, data.inputFile, data.agent);
  showCleanResult(result, data.inputFile);
  emitClearMissingOutputs({
    streamConfig: {
      agent: data.agent,
      model: data.model,
      inputFile: data.inputFile,
      outputFiles,
    },
  });
}

async function handleCleanSingle(
  inputFile: string,
  agent: string,
  model: string,
): Promise<void> {
  await runCleanCommand(inputFile, agent, model, 'cleanSingle params', []);
}

async function handleCleanMultiple(
  inputFile: string,
  agent: string,
  model: string,
  inputFiles: string[] = [],
): Promise<void> {
  await runCleanCommand(
    inputFile,
    agent,
    model,
    'cleanMultiple params',
    inputFiles,
  );
}

async function handleClean(config: unknown): Promise<void> {
  const data = await parseWithErrorDisplay(
    CHANNEL,
    CleanConfigSchema,
    config,
    'config',
  );
  if (!data) return;

  const {
    agent,
    model,
    inputFile,
    outputFiles,
    streamId,
    executionId,
    skipProgressViewClear,
  } = data;

  logger.debug(
    CHANNEL,
    `Clean command called with config: ${JSON.stringify(data)}`,
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
