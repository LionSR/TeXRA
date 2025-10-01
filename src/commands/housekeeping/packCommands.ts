// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - progress view
import { bus } from '@eventBus/ProgressEventBus';

// Local imports - log
import * as logger from '@logger/logUtils';

// Local imports - utilities
import { getStreamTabId } from '@/logger/streamUtils';
import { WorkspaceFS } from '@utils/files';

// Local imports - housekeeping
import { runPack, runPackSingle, runPackMultiple } from '@housekeeping';
import type { FileOpResult } from '@agent/types/ResultTypes';
import {
  showLoggedErrorMessage,
  showLoggedMessage,
} from '@common/errors/errorHandlingUtils';

const CHANNEL = 'packCommands';
logger.initialize(CHANNEL);

function showPackResult(result: FileOpResult, inputFile: string): void {
  switch (result.status) {
    case 'success':
      if (result.outputFolder) {
        const openFolder = 'Open Folder';
        const outputFolder = result.outputFolder;
        const folderPath = path.isAbsolute(outputFolder)
          ? outputFolder
          : WorkspaceFS.fullPath(outputFolder);
        vscode.window
          .showInformationMessage(
            `Files packed into ${outputFolder}`,
            openFolder,
          )
          .then((selection) => {
            if (selection === openFolder) {
              void vscode.commands.executeCommand(
                'revealFileInOS',
                vscode.Uri.file(folderPath),
              );
            }
          });
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

async function handlePack(config: { streamId?: string; [key: string]: any }) {
  logger.debug(
    CHANNEL,
    `Pack command called with config: ${JSON.stringify(config)}`,
  );

  if (!config.agent || !config.inputFile) {
    await showLoggedMessage(CHANNEL, 'Missing required parameters in config');
    return;
  }

  const declaredOutputFiles = Array.isArray(config.outputFiles)
    ? config.outputFiles
    : [];
  const legacyActiveFlag =
    typeof config.activeFiles?.output === 'boolean'
      ? config.activeFiles.output
      : undefined;
  const useMultipleOutputs =
    typeof config.useMultipleOutputs === 'boolean'
      ? config.useMultipleOutputs
      : typeof legacyActiveFlag === 'boolean'
        ? legacyActiveFlag
        : declaredOutputFiles.length > 1;

  if (declaredOutputFiles.length > 1 && !useMultipleOutputs) {
    logger.warn(
      CHANNEL,
      'Pack command received multiple output files but multi-output mode is disabled. Verify stored task state.',
    );
  }

  const outputFiles = useMultipleOutputs ? declaredOutputFiles : [];

  const result = await runPack(
    config.model,
    config.inputFile,
    config.agent,
    outputFiles,
    config.executionId ? { executionId: config.executionId } : undefined,
  );
  showPackResult(result, config.inputFile);

  const streamId =
    config.streamId ||
    getStreamTabId(config.agent, config.model, config.inputFile, {
      useMultipleOutputs,
    });
  bus.emit('clearOutputFiles', streamId);
  bus.emit('clearMissingOutputs', streamId);
  bus.emit('clearTaskOutput', streamId);
}

async function handlePackSingle(
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
      `Missing required parameters for packSingle: ${missing.join(', ')}`,
    );
    return;
  }

  const result = await runPackSingle(model, inputFile, agent);
  showPackResult(result, inputFile);

  const streamId = getStreamTabId(agent, model, inputFile, {
    useMultipleOutputs: false,
  });
  bus.emit('clearOutputFiles', streamId);
  bus.emit('clearMissingOutputs', streamId);
  bus.emit('clearTaskOutput', streamId);
}

async function handlePackMultiple(
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

  if ((!inputFile && !outputFiles.length) || !agent || !model) {
    const missing = [];
    if (!inputFile && !outputFiles.length)
      missing.push('inputFile or outputFiles');
    if (!agent) missing.push('agent');
    if (!model) missing.push('model');
    await showLoggedMessage(
      CHANNEL,
      `Missing required parameters for packMultiple: ${missing.join(', ')}`,
    );
    return;
  }

  const result = await runPackMultiple(model, inputFile, agent, outputFiles);
  showPackResult(result, inputFile);

  const streamId = getStreamTabId(agent, model, inputFile, {
    useMultipleOutputs: true,
  });
  bus.emit('clearOutputFiles', streamId);
  bus.emit('clearMissingOutputs', streamId);
  bus.emit('clearTaskOutput', streamId);
}

export const packCommands = {
  handlePack,
  handlePackSingle,
  handlePackMultiple,
};
