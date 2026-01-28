// Third-party imports
import * as vscode from 'vscode';
import { z } from 'zod';

// Local imports
import type { FileOpResult } from '@agent/types';
import { parseWithErrorDisplay } from '@common/errors';
import * as logger from '@logger/logUtils';
import {
  runCleanSingle,
  runCleanMultiple,
  runCleanBuild,
  runCleanOutput,
} from '@housekeeping';
import { emitClearMissingOutputs } from './streamEventUtils';

const CHANNEL = 'cleanCommands';
logger.initialize(CHANNEL);

// --- Schemas ---

const RequiredString = z.string().min(1);

/** Base params shared by all clean commands */
const CleanParamsSchema = z.object({
  inputFile: RequiredString,
  agent: RequiredString,
  model: RequiredString,
});

/** Extended config for main clean command */
const CleanConfigSchema = CleanParamsSchema.extend({
  outputFiles: z.array(z.string()).prefault([]),
  useMultipleOutputs: z.boolean().optional(),
  streamId: z.string().optional(),
  skipProgressViewClear: z.boolean().optional(),
}).transform((c) => ({
  ...c,
  useMultipleOutputs: c.useMultipleOutputs ?? c.outputFiles.length > 0,
}));

// --- Helpers ---

function showCleanResult(result: FileOpResult, inputFile: string): void {
  const status = result.status;
  const isError = status === 'missingParams' || status === 'error';

  let message: string;
  if (status === 'success') {
    message = `Cleanup complete for ${inputFile}`;
  } else if (status === 'noFiles') {
    message = `No files found to clean for ${inputFile}`;
  } else if (status === 'missingParams') {
    message = 'Missing required parameters for clean';
  } else {
    message = `Error during cleanup: ${result.error}`;
  }

  if (isError) {
    vscode.window.showErrorMessage(message);
  } else {
    vscode.window.showInformationMessage(message);
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
    },
    useMultipleOutputs: false,
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
    },
    useMultipleOutputs: true,
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
    skipProgressViewClear,
  } = data;

  logger.debug(
    CHANNEL,
    `Clean command called with config: ${JSON.stringify(data)}`,
  );

  const result =
    useMultipleOutputs && outputFiles.length > 0
      ? await runCleanMultiple(model, inputFile, agent, outputFiles)
      : await runCleanSingle(model, inputFile, agent);
  showCleanResult(result, inputFile);

  if (!skipProgressViewClear) {
    emitClearMissingOutputs({
      streamConfig: { agent, model, inputFile },
      useMultipleOutputs,
      streamIdOverride: streamId,
    });
  }
}
