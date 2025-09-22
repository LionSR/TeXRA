import * as vscode from 'vscode';
import { createChannelLogger } from '@logger/logUtils';

// Local imports - utils
import { safeExecuteCommand } from '@utils/system';

const CHANNEL = 'progressViewCommands';
const logger = createChannelLogger(CHANNEL);

/**
 * Show the Progress View panel
 */
async function showProgressView() {
  // Focus the view in the panel
  await safeExecuteCommand('workbench.view.extension.texra-panel', [], CHANNEL);

  // Then specifically focus the progress view
  await safeExecuteCommand('texra.progressView.focus', [], CHANNEL);

  logger.info('ProgressView panel shown');
}

/**
 * Register all progress view related commands
 */
export function registerProgressViewCommands(context: vscode.ExtensionContext) {
  logger.debug('Registering progress view commands');

  context.subscriptions.push(
    vscode.commands.registerCommand('texra.showProgressView', showProgressView),
  );

  return {
    showProgressView,
  };
}
