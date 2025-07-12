// Third-party imports
import * as vscode from 'vscode';

// Local imports - progress view
import { emitProgress } from '@eventBus/ProgressEventBus';

// Local imports - log
import * as logger from '@logger/logUtils';

// Local imports - utilities
import { getStreamTabId } from '@/logger/streamUtils';

// Local imports - housekeeping
import { runPack, runPackSingle, runPackMultiple } from '@housekeeping';
import type { FileOpResult } from '@agent/types/ResultTypes';
import { showLoggedMessage } from '@common/errors/errorHandlingUtils';
import { HousekeepingCommandConfigSchema } from './HousekeepingCommandConfig';

const CHANNEL = 'packCommands';
logger.initialize(CHANNEL);

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

async function handlePack(config: { streamId?: string; [key: string]: any }) {
  logger.debug(
    CHANNEL,
    `Pack command called with config: ${JSON.stringify(config)}`,
  );

  const parsed = HousekeepingCommandConfigSchema.safeParse(config);
  if (!parsed.success) {
    const issues = parsed.error.errors
      .map((e) => `${e.path.join('.')} ${e.message}`)
      .join('; ');
    await showLoggedMessage(CHANNEL, `Invalid pack configuration: ${issues}`);
    return;
  }
  const cfg = parsed.data;

  // Get output files if multiple files mode is enabled
  const outputFiles = cfg.activeFiles?.output ? cfg.outputFiles || [] : [];

  const result = await runPack(
    cfg.model,
    cfg.inputFile,
    cfg.agent,
    outputFiles,
  );
  showPackResult(result, cfg.inputFile);

  const streamId =
    cfg.streamId ||
    getStreamTabId(cfg.agent, cfg.model, cfg.inputFile, outputFiles);
  emitProgress('clearOutputFiles', streamId);
  emitProgress('clearMissingOutputs', streamId);
  emitProgress('clearTaskOutput', streamId);
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

  const streamId = getStreamTabId(agent, model, inputFile);
  emitProgress('clearOutputFiles', streamId);
  emitProgress('clearMissingOutputs', streamId);
  emitProgress('clearTaskOutput', streamId);
}

async function handlePackMultiple(config: {
  streamId?: string;
  [key: string]: any;
}) {
  logger.debug(
    CHANNEL,
    `Command called with config: ${JSON.stringify(config)}`,
  );

  const parsed = HousekeepingCommandConfigSchema.safeParse(config);
  if (!parsed.success) {
    const issues = parsed.error.errors
      .map((e) => `${e.path.join('.')} ${e.message}`)
      .join('; ');
    await showLoggedMessage(CHANNEL, `Invalid pack configuration: ${issues}`);
    return;
  }
  const cfg = parsed.data;

  const outputFiles = cfg.activeFiles?.output ? cfg.outputFiles || [] : [];

  const result = await runPackMultiple(
    cfg.model,
    cfg.inputFile,
    cfg.agent,
    outputFiles,
  );
  showPackResult(result, cfg.inputFile);

  const streamId = getStreamTabId(
    cfg.agent,
    cfg.model,
    cfg.inputFile,
    outputFiles,
  );
  emitProgress('clearOutputFiles', streamId);
  emitProgress('clearMissingOutputs', streamId);
  emitProgress('clearTaskOutput', streamId);
}

export const packCommands = {
  handlePack,
  handlePackSingle,
  handlePackMultiple,
};
