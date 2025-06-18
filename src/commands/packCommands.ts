// Third-party imports
import * as vscode from 'vscode';
import * as path from 'path';

import { ProgressViewProvider } from '../progressView/ProgressViewProvider';

// Local imports - log
import * as logger from '@logger/logUtils';

// Local imports - housekeeping
import { runPack, runPackSingle, runPackMultiple } from '../housekeeping';
import type { FileOpResult } from '@/types/ResultTypes';

const CHANNEL = 'packCommands';
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

function showPackResult(result: FileOpResult, inputFile: string): void {
  switch (result.status) {
    case 'success':
      if (result.outputFolder) {
        vscode.window.showInformationMessage(
          `Files packed into ${result.outputFolder}`,
        );
      }
      break;
    case 'noFiles':
      vscode.window.showInformationMessage(
        `No files found to pack for ${inputFile}`,
      );
      break;
    case 'missingParams':
      vscode.window.showErrorMessage('Missing required parameters for pack');
      break;
    case 'error':
      vscode.window.showErrorMessage(`Error during packing: ${result.error}`);
      break;
    default:
      break;
  }
}

export function registerPackCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('texra.pack', handlePack),
    vscode.commands.registerCommand('texra.packSingle', handlePackSingle),
    vscode.commands.registerCommand('texra.packMultiple', handlePackMultiple),
  );
}

async function handlePack(config: any) {
  logger.debug(
    CHANNEL,
    `Pack command called with config: ${JSON.stringify(config)}`,
  );

  if (!config.agent || !config.inputFile) {
    logger.error(CHANNEL, 'Missing required parameters in config');
    vscode.window.showErrorMessage('Missing required parameters for pack');
    return;
  }

  // Get output files if multiple files mode is enabled
  const outputFiles = config.activeFiles?.output
    ? config.outputFiles || []
    : [];

  const result = await runPack(
    config.model,
    config.inputFile,
    config.agent,
    outputFiles,
    config.outputNameOverride,
  );
  showPackResult(result, config.inputFile);

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

async function handlePackSingle(
  inputFile: string,
  agent: string,
  model: string,
  outputNameOverride?: string,
) {
  logger.debug(
    CHANNEL,
    `Command called with: inputFile=${inputFile}, agent=${agent}, model=${model}, outputNameOverride=${outputNameOverride}`,
  );

  if (!inputFile || !agent || !model) {
    logger.error(
      CHANNEL,
      `Missing required parameters: inputFile=${inputFile}, agent=${agent}, model=${model}`,
    );
    vscode.window.showErrorMessage(
      'Missing required parameters for packSingle',
    );
    return;
  }

  const fileToPack = outputNameOverride || inputFile;
  const result = await runPackSingle(model, fileToPack, agent);
  showPackResult(result, fileToPack);

  const provider = ProgressViewProvider.getInstance();
  if (provider) {
    const streamId = getStreamId(agent, model, inputFile);
    provider.clearOutputFiles(streamId);
    provider.clearTaskOutput(streamId);
  }
}

async function handlePackMultiple(
  inputFile: string,
  agent: string,
  model: string,
  outputFiles: string[] = [],
  outputNameOverride?: string,
) {
  logger.debug(
    CHANNEL,
    `Command called with: inputFile=${inputFile}, agent=${agent}, model=${model}, outputNameOverride=${outputNameOverride}`,
  );
  logger.debug(CHANNEL, `Additional files: ${outputFiles.join(', ')}`);

  if ((!inputFile && !outputFiles.length) || !agent || !model) {
    logger.error(
      CHANNEL,
      `Missing required parameters: inputFile=${inputFile}, agent=${agent}, model=${model}`,
    );
    vscode.window.showErrorMessage(
      'Missing required parameters for packMultiple:',
    );
    return;
  }

  const result = await runPackMultiple(
    model,
    inputFile,
    agent,
    outputFiles,
    outputNameOverride,
  );
  showPackResult(result, inputFile);

  const provider = ProgressViewProvider.getInstance();
  if (provider) {
    const streamId = getStreamId(agent, model, inputFile, outputFiles);
    provider.clearOutputFiles(streamId);
    provider.clearTaskOutput(streamId);
  }
}

export const packCommands = {
  handlePack,
  handlePackSingle,
  handlePackMultiple,
};
