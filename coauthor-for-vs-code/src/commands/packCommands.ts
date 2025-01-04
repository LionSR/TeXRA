// Third-party imports
import * as vscode from 'vscode';

// Local imports - core
import * as logger from '../logger/logUtils';

// Local imports - housekeeping
import {
  runPackSingle,
  runPackMultiple,
  runCleanSingle,
  runCleanMultiple,
  runCleanBuild,
  runCleanOutput,
  runIndentTex,
} from '../housekeeping';

const CHANNEL = 'PackCommands';

export function registerPackCommands(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('coauthor.packSingle', handlePackSingle),
    vscode.commands.registerCommand(
      'coauthor.packMultiple',
      handlePackMultiple,
    ),
    vscode.commands.registerCommand('coauthor.cleanOutput', runCleanOutput),
    vscode.commands.registerCommand('coauthor.cleanBuild', runCleanBuild),
    vscode.commands.registerCommand('coauthor.indentTex', runIndentTex),
    vscode.commands.registerCommand('coauthor.cleanSingle', handleCleanSingle),
    vscode.commands.registerCommand(
      'coauthor.cleanMultiple',
      handleCleanMultiple,
    ),
  );
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
      'Missing required parameters for pack single',
    );
    return;
  }
  await runPackSingle(model, inputFile, agent, outputNameOverride);
}

async function handlePackMultiple(
  inputFile: string,
  agent: string,
  model: string,
  outputFiles: string[],
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
      'Missing required parameters for pack multiple',
    );
    return;
  }

  await runPackMultiple(
    model,
    inputFile,
    agent,
    outputFiles,
    outputNameOverride,
  );
}

async function handleCleanSingle(
  inputFile: string,
  agent: string,
  model: string,
  outputNameOverride: string,
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
      'Missing required parameters for clean single',
    );
    return;
  }
  if (outputNameOverride) {
    await runCleanSingle(model, outputNameOverride, agent);
  } else {
    await runCleanSingle(model, inputFile, agent);
  }
}

async function handleCleanMultiple(
  inputFile: string,
  agent: string,
  model: string,
  outputFiles: string[],
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

export const packCommands = {
  handlePackSingle,
  handlePackMultiple,
  handleCleanSingle,
  handleCleanMultiple,
};
