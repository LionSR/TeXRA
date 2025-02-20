// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports - housekeeping
import {
  runCleanSingle,
  runCleanMultiple,
  runCleanBuild,
  runCleanOutput,
} from '../housekeeping';

const CHANNEL = 'cleanCommands';
logger.initialize(CHANNEL);

export function registerCleanCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('coauthor.clean', handleClean),
    vscode.commands.registerCommand('coauthor.cleanSingle', handleCleanSingle),
    vscode.commands.registerCommand(
      'coauthor.cleanMultiple',
      handleCleanMultiple,
    ),
    vscode.commands.registerCommand('coauthor.cleanOutput', runCleanOutput),
    vscode.commands.registerCommand('coauthor.cleanBuild', runCleanBuild),
  );
}

async function handleCleanSingle(
  inputFile: string,
  agent: string,
  model: string,
  outputNameOverride: string = '',
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
      'Missing required parameters for cleanSingle',
    );
    return;
  }
  await runCleanSingle(model, outputNameOverride || inputFile, agent);
}

async function handleCleanMultiple(
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

  const inputFilesWithOverride = outputNameOverride
    ? [outputNameOverride, ...outputFiles]
    : outputFiles;

  await runCleanMultiple(model, inputFile, agent, inputFilesWithOverride);
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

  const outputFiles = config.multipleOutputFilesVisible
    ? config.multipleOutputFiles || []
    : [];

  if (outputFiles.length > 0) {
    logger.info(
      CHANNEL,
      `Running clean multiple with ${outputFiles.length} files`,
    );
    await runCleanMultiple(
      config.model,
      config.inputFile,
      config.agent,
      outputFiles,
    );
  } else {
    logger.info(CHANNEL, `Running clean single`);
    await runCleanSingle(config.model, config.inputFile, config.agent);
  }
}

export const cleanCommands = {
  handleCleanSingle,
  handleCleanMultiple,
  handleClean,
};
