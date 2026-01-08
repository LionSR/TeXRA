// Third-party imports
import * as vscode from 'vscode';

// Internal imports
import { safeExecuteCommand } from '@frontend/system/commandUtils';
import { AgentLogger } from '@logger/AgentLogger';
import { ProgressViewProvider } from '@progressView/ProgressViewProvider';

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
 * Open the Progress View in a separate editor tab
 */
function openProgressViewInTab() {
  const provider = ProgressViewProvider.getInstance();
  if (!provider) {
    logger.error('ProgressViewProvider not initialized');
    vscode.window.showErrorMessage(
      'Progress View is not available. Please try again.',
    );
    return;
  }

  provider.showProgressViewAsPanel();
  logger.info('ProgressView opened in separate tab');
}

/**
 * Register all progress view related commands
 */
export function registerProgressViewCommands(context: vscode.ExtensionContext) {
  logger.debug('Registering progress view commands');

  context.subscriptions.push(
    vscode.commands.registerCommand('texra.showProgressView', showProgressView),
    vscode.commands.registerCommand(
      'texra.openProgressViewInTab',
      openProgressViewInTab,
    ),
  );

  return {
    showProgressView,
    openProgressViewInTab,
  };
}
