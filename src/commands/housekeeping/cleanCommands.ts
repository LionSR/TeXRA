// Third-party imports
import * as vscode from 'vscode';

// Local imports - progress view
import { bus } from '@eventBus/ProgressEventBus';

// Local imports - log
import * as logger from '@logger/logUtils';

// Local imports - utilities
import { getStreamTabId } from '@/logger/streamUtils';

// Local imports - housekeeping
import {
  runCleanSingle,
  runCleanMultiple,
  runCleanBuild,
  runCleanOutput,
} from '@housekeeping';
import type { FileOpResult } from '@agent/types/ResultTypes';
import {
  showLoggedErrorMessage,
  showLoggedMessage,
} from '@common/errors/errorHandlingUtils';

const CHANNEL = 'cleanCommands';
logger.initialize(CHANNEL);

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
    default:
      break;
  }
}

export function registerCleanCommands(context: vscode.ExtensionContext) {
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
) {
  logger.debug(
    CHANNEL,
    `Command called with: inputFile=${inputFile}, agent=${agent}, model=${model}`,
  );

  if (!inputFile || !agent || !model) {
    const missing = [];
    if (!inputFile) missing.push('inputFile');
    if (!agent) missing.push('agent');
    if (!model) missing.push('model');
    await showLoggedMessage(
      CHANNEL,
      `Missing required parameters for cleanSingle: ${missing.join(', ')}`,
    );
    return;
  }
  const result = await runCleanSingle(model, inputFile, agent);
  showCleanResult(result, inputFile);

  const streamId = getStreamTabId(agent, model, inputFile, {
    useMultipleOutputs: false,
  });
  bus.emit('clearOutputFiles', streamId);
  bus.emit('clearMissingOutputs', streamId);
  bus.emit('clearTaskOutput', streamId);
}

async function handleCleanMultiple(
  inputFile: string,
  agent: string,
  model: string,
  outputFiles: string[] = [],
) {
  logger.debug(
    CHANNEL,
    `Command called with: inputFile=${inputFile}, agent=${agent}, model=${model}`,
  );
  logger.debug(CHANNEL, `Additional files: ${outputFiles.join(', ')}`);

  if (!inputFile || !agent || !model) {
    const missing = [];
    if (!inputFile) missing.push('inputFile');
    if (!agent) missing.push('agent');
    if (!model) missing.push('model');
    await showLoggedMessage(
      CHANNEL,
      `Missing required parameters for cleanMultiple: ${missing.join(', ')}`,
    );
    return;
  }

  const result = await runCleanMultiple(model, inputFile, agent, outputFiles);
  showCleanResult(result, inputFile);

  const streamId = getStreamTabId(agent, model, inputFile, {
    useMultipleOutputs: true,
  });
  bus.emit('clearOutputFiles', streamId);
  bus.emit('clearMissingOutputs', streamId);
  bus.emit('clearTaskOutput', streamId);
}

export async function handleClean(config: {
  streamId?: string;
  [key: string]: any;
}) {
  logger.debug(
    CHANNEL,
    `Clean command called with config: ${JSON.stringify(config)}`,
  );

  if (!config.agent || !config.inputFile) {
    await showLoggedMessage(CHANNEL, 'Missing required parameters in config');
    return;
  }

  const declaredOutputFiles = Array.isArray(config.outputFiles)
    ? config.outputFiles
    : [];
  const useMultipleOutputs =
    config.useMultipleOutputs ?? declaredOutputFiles.length > 1;

  const outputFiles = useMultipleOutputs ? declaredOutputFiles : [];

  if (useMultipleOutputs && outputFiles.length > 0) {
    logger.info(
      CHANNEL,
      `Running clean multiple with ${outputFiles.length} files`,
    );
    const result = await runCleanMultiple(
      config.model,
      config.inputFile,
      config.agent,
      outputFiles,
    );
    showCleanResult(result, config.inputFile);
  } else {
    logger.info(CHANNEL, `Running clean single`);
    const result = await runCleanSingle(
      config.model,
      config.inputFile,
      config.agent,
    );
    showCleanResult(result, config.inputFile);
  }

  const streamId =
    config.streamId ||
    getStreamTabId(config.agent, config.model, config.inputFile, {
      useMultipleOutputs,
    });
  bus.emit('clearOutputFiles', streamId);
  bus.emit('clearMissingOutputs', streamId);
  bus.emit('clearTaskOutput', streamId);
}

export const cleanCommands = {
  handleCleanSingle,
  handleCleanMultiple,
  handleClean,
};
