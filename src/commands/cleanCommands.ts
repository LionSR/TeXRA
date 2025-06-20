// Third-party imports
import * as vscode from 'vscode';
import * as path from 'path';

import { ProgressViewProvider } from '@progressView/ProgressViewProvider';

// Local imports - log
import * as logger from '@logger/logUtils';

// Local imports - housekeeping
import {
  runCleanSingle,
  runCleanMultiple,
  runCleanBuild,
  runCleanOutput,
} from '@housekeeping';
import type { FileOpResult } from '@/types/ResultTypes';

const CHANNEL = 'cleanCommands';
logger.initialize(CHANNEL);

function getStreamId(
  agent: string,
  model: string,
  inputFile: string,
  outputFiles?: string[],
): string {
  const agentName =
    outputFiles && outputFiles.length > 1 ? `${agent}_multiple` : agent;
  return `${agentName}@${model}: ${path.basename(inputFile)}`;
}

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
    logger.error(
      CHANNEL,
      `Missing required parameters: inputFile=${inputFile}, agent=${agent}, model=${model}`,
    );
    vscode.window.showErrorMessage(
      'Missing required parameters for cleanSingle',
    );
    return;
  }
  const result = await runCleanSingle(model, inputFile, agent);
  showCleanResult(result, inputFile);

  const provider = ProgressViewProvider.getInstance();
  if (provider) {
    const streamId = getStreamId(agent, model, inputFile);
    provider.clearOutputFiles(streamId);
    provider.clearTaskOutput(streamId);
  }
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
    logger.error(
      CHANNEL,
      `Missing required parameters: inputFile=${inputFile}, agent=${agent}, model=${model}`,
    );
    vscode.window.showErrorMessage(
      'Missing required parameters for clean multiple',
    );
    return;
  }

  const result = await runCleanMultiple(model, inputFile, agent, outputFiles);
  showCleanResult(result, inputFile);

  const provider = ProgressViewProvider.getInstance();
  if (provider) {
    const streamId = getStreamId(agent, model, inputFile, outputFiles);
    provider.clearOutputFiles(streamId);
    provider.clearTaskOutput(streamId);
  }
}

export async function handleClean(config: any) {
  logger.debug(
    CHANNEL,
    `Clean command called with config: ${JSON.stringify(config)}`,
  );

  if (!config.agent || !config.inputFile) {
    logger.error(CHANNEL, 'Missing required parameters in config');
    vscode.window.showErrorMessage('Missing required parameters for clean');
    return;
  }

  const outputFiles = config.activeFiles?.output
    ? config.outputFiles || []
    : [];

  if (outputFiles.length > 0) {
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

  const provider = ProgressViewProvider.getInstance();
  if (provider) {
    const streamId = getStreamId(
      config.agent,
      config.model,
      config.inputFile,
      outputFiles,
    );
    provider.clearOutputFiles(streamId);
    provider.clearTaskOutput(streamId);
  }
}

export const cleanCommands = {
  handleCleanSingle,
  handleCleanMultiple,
  handleClean,
};
