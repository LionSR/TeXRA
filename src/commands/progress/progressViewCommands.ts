// Third-party imports
import * as vscode from 'vscode';

// Internal imports
import { AgentLogger } from '@logger/AgentLogger';
import { safeExecuteCommand } from '@frontend/system/commandUtils';

const CHANNEL = 'progressViewCommands';
const logger = new AgentLogger(CHANNEL);

/**
 * Show the Progress View panel
 */
async function showProgressView() {
  // Focus the progress view
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
