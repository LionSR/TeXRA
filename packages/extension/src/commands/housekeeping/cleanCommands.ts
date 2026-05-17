// Third-party imports
import * as vscode from 'vscode';
import { z } from 'zod';

// Local imports
import type { FileOpResult } from '@agent/types';
import { parseWithErrorDisplay } from '@frontend/ui/errorHandlingUtils';
import {
  runCleanSingle,
  runCleanMultiple,
  runCleanRunDir,
} from '@housekeeping';
import * as logger from '@logger/logUtils';
import { ExecutionIdSchema } from '@shared/schemas';
import { emitClearMissingOutputs } from './streamEventUtils';

const CHANNEL = 'cleanCommands';
logger.initialize(CHANNEL);

const RequiredString = z.string().min(1);

const CleanParamsSchema = z.object({
  inputFile: RequiredString,
  agent: RequiredString,
  model: RequiredString,
});

const CleanConfigSchema = CleanParamsSchema.extend({
  outputFiles: z.array(z.string()).prefault([]),
  streamId: z.string().optional(),
  executionId: ExecutionIdSchema.optional(),
  skipProgressViewClear: z.boolean().optional(),
});

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
      vscode.window.showErrorMessage('Missing required parameters for clean');
      break;
    case 'error':
      vscode.window.showErrorMessage(`Error during cleanup: ${result.error}`);
      break;
  }
}

export function registerCleanCommands(context: vscode.ExtensionContext): void {
  // `texra.cleanOutput` and `texra.cleanBuild` are registered through
  // `extensionCommandSurface` so the dispatch path matches the desktop
  // registry (see #3771). The remaining clean commands take typed
  // arguments and stay on per-command registration for now.
  context.subscriptions.push(
    vscode.commands.registerCommand('texra.clean', handleClean),
    vscode.commands.registerCommand('texra.cleanSingle', handleCleanSingle),
    vscode.commands.registerCommand('texra.cleanMultiple', handleCleanMultiple),
  );
}

async function handleCleanSingle(
  inputFile: string,
  agent: string,
  model: string,
): Promise<void> {
  const data = await parseWithErrorDisplay(
    CHANNEL,
    CleanParamsSchema,
    { inputFile, agent, model },
    'cleanSingle params',
  );
  if (!data) return;

  const result = await runCleanSingle(data.model, data.inputFile, data.agent);
  showCleanResult(result, data.inputFile);
  emitClearMissingOutputs({
    streamConfig: {
      agent: data.agent,
      model: data.model,
      inputFile: data.inputFile,
      outputFiles: [],
    },
  });
}

async function handleCleanMultiple(
  inputFile: string,
  agent: string,
  model: string,
  inputFiles: string[] = [],
): Promise<void> {
  const data = await parseWithErrorDisplay(
    CHANNEL,
    CleanParamsSchema,
    { inputFile, agent, model },
    'cleanMultiple params',
  );
  if (!data) return;

  logger.debug(CHANNEL, `Additional files: ${inputFiles.join(', ')}`);

  const result = await runCleanMultiple(
    data.model,
    data.inputFile,
    data.agent,
    inputFiles,
  );
  showCleanResult(result, data.inputFile);
  emitClearMissingOutputs({
    streamConfig: {
      agent: data.agent,
      model: data.model,
      inputFile: data.inputFile,
      outputFiles: inputFiles,
    },
  });
}

export async function handleClean(config: unknown): Promise<void> {
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
    // Surface errors from either leg — a failed runDir removal (e.g.
    // permission-denied) must not be masked by a successful workspace
    // sweep, or the user sees "Cleanup complete" while `executions/{id}`
    // remains on disk.
    if (runDirResult.status === 'error') {
      result = runDirResult;
    } else if (workspaceResult.status === 'error') {
      result = workspaceResult;
    } else {
      result =
        workspaceResult.status !== 'noFiles' ? workspaceResult : runDirResult;
    }
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
