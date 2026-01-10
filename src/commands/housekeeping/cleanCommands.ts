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
  const parsed = CleanParamsSchema.safeParse({ inputFile, agent, model });
  if (!parsed.success) {
    await showLoggedMessage(
      CHANNEL,
      `Invalid params for cleanSingle: ${formatZodError(parsed.error)}`,
    );
    return;
  }

  const data = parsed.data;
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
  const parsed = CleanParamsSchema.safeParse({ inputFile, agent, model });
  if (!parsed.success) {
    await showLoggedMessage(
      CHANNEL,
      `Invalid params for cleanMultiple: ${formatZodError(parsed.error)}`,
    );
    return;
  }
  logger.debug(CHANNEL, `Additional files: ${outputFiles.join(', ')}`);

  const data = parsed.data;
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

export const cleanCommands = {
  handleCleanSingle,
  handleCleanMultiple,
  handleClean,
};
