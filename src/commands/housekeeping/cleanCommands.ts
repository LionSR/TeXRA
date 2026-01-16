// Third-party imports
import * as vscode from 'vscode';
import { z } from 'zod';

// Local imports
import type { FileOpResult } from '@agent/types/ResultTypes';
import { formatZodError, showLoggedMessage } from '@common/errors';
import * as logger from '@logger/logUtils';
import { bus } from '@eventBus/ProgressEventBus';
import {
  runCleanSingle,
  runCleanMultiple,
  runCleanBuild,
  runCleanOutput,
} from '@housekeeping';
import { getStreamTabId } from '@/logger/streamUtils';

const CHANNEL = 'cleanCommands';
logger.initialize(CHANNEL);

// --- Schemas ---

const RequiredString = z.string().min(1);

/** For cleanSingle/cleanMultiple - all fields required */
const CleanParamsSchema = z.object({
  inputFile: RequiredString,
  agent: RequiredString,
  model: RequiredString,
});

// --- Helpers ---

function showCleanResult(result: FileOpResult, inputFile: string): void {
  const isError = result.status === 'missingParams' || result.status === 'error';
  const messages: Record<FileOpResult['status'], string> = {
    success: `Cleanup complete for ${inputFile}`,
    noFiles: `No files found to clean for ${inputFile}`,
    missingParams: 'Missing required parameters for clean',
    error: `Error during cleanup: ${result.error}`,
  };
  const text = messages[result.status];
  if (isError) {
    vscode.window.showErrorMessage(text);
  } else {
    vscode.window.showInformationMessage(text);
  }
}

/** Validate clean params and log error if invalid. Returns parsed data or null. */
async function validateCleanParams(
  inputFile: string,
  agent: string,
  model: string,
  commandName: string,
): Promise<z.infer<typeof CleanParamsSchema> | null> {
  const parsed = CleanParamsSchema.safeParse({ inputFile, agent, model });
  if (!parsed.success) {
    await showLoggedMessage(
      CHANNEL,
      `Invalid params for ${commandName}: ${formatZodError(parsed.error)}`,
    );
    return null;
  }
  return parsed.data;
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
  const data = await validateCleanParams(inputFile, agent, model, 'cleanSingle');
  if (!data) return;

  const result = await runCleanSingle(data.model, data.inputFile, data.agent);
  showCleanResult(result, data.inputFile);

  const streamId = getStreamTabId(data.agent, data.model, data.inputFile, {
    useMultipleOutputs: false,
  });
  bus.emit('clearMissingOutputs', { stream: streamId });
}

async function handleCleanMultiple(
  inputFile: string,
  agent: string,
  model: string,
  outputFiles: string[] = [],
): Promise<void> {
  const data = await validateCleanParams(inputFile, agent, model, 'cleanMultiple');
  if (!data) return;

  logger.debug(CHANNEL, `Additional files: ${outputFiles.join(', ')}`);

  const result = await runCleanMultiple(
    data.model,
    data.inputFile,
    data.agent,
    outputFiles,
  );
  showCleanResult(result, data.inputFile);

  const streamId = getStreamTabId(data.agent, data.model, data.inputFile, {
    useMultipleOutputs: true,
  });
  bus.emit('clearMissingOutputs', { stream: streamId });
}

export async function handleClean(config: {
  agent?: string;
  model?: string;
  inputFile?: string;
  outputFiles?: string[];
  useMultipleOutputs?: boolean;
  streamId?: string;
  skipProgressViewClear?: boolean;
}): Promise<void> {
  logger.debug(
    CHANNEL,
    `Clean command called with config: ${JSON.stringify(config)}`,
  );

  const { agent, model, inputFile } = config;
  if (!agent || !model || !inputFile) {
    await showLoggedMessage(CHANNEL, 'Missing required parameters in config');
    return;
  }

  const outputFiles = Array.isArray(config.outputFiles)
    ? config.outputFiles
    : [];
  const useMultipleOutputs =
    config.useMultipleOutputs ?? outputFiles.length > 1;

  const result =
    useMultipleOutputs && outputFiles.length > 0
      ? await runCleanMultiple(model, inputFile, agent, outputFiles)
      : await runCleanSingle(model, inputFile, agent);
  showCleanResult(result, inputFile);

  const streamId =
    config.streamId ||
    getStreamTabId(agent, model, inputFile, { useMultipleOutputs });

  if (!config.skipProgressViewClear) {
    bus.emit('clearMissingOutputs', { stream: streamId });
  }
}
