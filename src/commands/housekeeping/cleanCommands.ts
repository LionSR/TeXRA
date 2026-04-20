// Third-party imports
import * as vscode from 'vscode';
import { z } from 'zod';

// Local imports
import type { FileOpResult } from '@agent/types';
import { parseWithErrorDisplay } from '@common/errors';
import {
  runCleanSingle,
  runCleanMultiple,
  runCleanBuild,
  runCleanOutput,
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
  useMultipleOutputs: z.boolean().optional(),
  streamId: z.string().optional(),
  executionId: ExecutionIdSchema.optional(),
  skipProgressViewClear: z.boolean().optional(),
}).transform((c) => ({
  ...c,
  useMultipleOutputs: c.useMultipleOutputs ?? c.outputFiles.length > 0,
}));

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
  context.subscriptions.push(
    vscode.commands.registerCommand('texra.clean', handleClean),
    vscode.commands.registerCommand('texra.cleanSingle', handleCleanSingle),
    vscode.commands.registerCommand('texra.cleanMultiple', handleCleanMultiple),
    vscode.commands.registerCommand('texra.cleanOutput', runCleanOutput),
    vscode.commands.registerCommand('texra.cleanBuild', runCleanBuild),
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
      useMultipleOutputs: false,
    },
  });
}

async function handleCleanMultiple(
  inputFile: string,
  agent: string,
  model: string,
  outputFiles: string[] = [],
): Promise<void> {
  const data = await parseWithErrorDisplay(
    CHANNEL,
    CleanParamsSchema,
    { inputFile, agent, model },
    'cleanMultiple params',
  );
  if (!data) return;

  logger.debug(CHANNEL, `Additional files: ${outputFiles.join(', ')}`);

  const result = await runCleanMultiple(
    data.model,
    data.inputFile,
    data.agent,
    outputFiles,
  );
  showCleanResult(result, data.inputFile);
  emitClearMissingOutputs({
    streamConfig: {
      agent: data.agent,
      model: data.model,
      inputFile: data.inputFile,
      useMultipleOutputs: true,
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
    useMultipleOutputs,
    streamId,
    executionId,
    skipProgressViewClear,
  } = data;

  logger.debug(
    CHANNEL,
    `Clean command called with config: ${JSON.stringify(data)}`,
  );

  // Toolbar-driven invocations pass an executionId: delete the run's runDir
  // directly. Legacy callers without an executionId fall back to the
  // workspace-scan clean for pre-refactor files.
  const result = executionId
    ? await runCleanRunDir(executionId)
    : useMultipleOutputs && outputFiles.length > 0
      ? await runCleanMultiple(model, inputFile, agent, outputFiles)
      : await runCleanSingle(model, inputFile, agent);
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
              useMultipleOutputs,
            },
          },
    );
  }
}
