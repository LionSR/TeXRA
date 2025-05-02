import * as vscode from 'vscode';
import { AgentLogger } from '../logger/AgentLogger';

const CHANNEL = 'progressViewCommands';
const logger = new AgentLogger(CHANNEL);

/**
 * Show the Progress View panel
 */
async function showProgressView() {
  try {
    // Focus the view in the panel
    await vscode.commands.executeCommand(
      'workbench.view.extension.texra-panel',
    );

    // Then specifically focus the progress view
    await vscode.commands.executeCommand('texra.progressView.focus');

    logger.info('ProgressView panel shown');
  } catch (error) {
    logger.error(`Error showing ProgressView: ${error}`);
    vscode.window.showErrorMessage(`Could not open ProgressView: ${error}`);
  }
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
