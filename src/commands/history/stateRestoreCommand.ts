// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '@logger/logUtils';
import { objectToTaskState } from '@utils/config';
import { showLoggedErrorMessage } from '@common/errors/errorHandlingUtils';
import { bus } from '@eventBus/ProgressEventBus';

const CHANNEL = 'stateRestoreCommand';
logger.initialize(CHANNEL);

/**
 * Register state restore command with VS Code
 */
export function registerStateRestoreCommand(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('texra.restoreState', restoreState),
  );

  logger.info(CHANNEL, 'Registered state restore command');
  return { restoreState };
}

/**
 * Restore the main webview state with configuration from a log tab
 */
async function restoreState(config: any) {
  logger.debug(
    CHANNEL,
    `Restoring main webview state with config: ${JSON.stringify(config)}`,
  );

  try {
    // Create a complete state object from the task state using utility function
    const taskState = objectToTaskState(config);
    bus.emit('restoreStateRequest', {
      taskState,
      source: CHANNEL,
    });

    logger.info(CHANNEL, 'Main webview state restoration requested');
    // vscode.window.showInformationMessage('Configuration restored to main view');
  } catch (error) {
    await showLoggedErrorMessage(CHANNEL, 'Failed to restore state', error);
  }
}

export const stateRestoreCommand = {
  restoreState,
};
