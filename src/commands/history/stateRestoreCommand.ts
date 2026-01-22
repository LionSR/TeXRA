// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import { showLoggedErrorMessage, toErrorMessage } from '@common/errors';
import { setPendingState } from '@common/state';
import { getMainWebview } from '@frontend/system/commandUtils';
import * as logger from '@logger/logUtils';
import type { TaskState } from '@logger/TaskState';
// Type imports

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
}

/**
 * Restore the main webview state with configuration from a log tab.
 * @param state - The TaskState to restore
 * @param executeImmediately - If true, execute the agent after restoring state (for followup)
 */
async function restoreState(state: TaskState, executeImmediately?: boolean) {
  logger.debug(CHANNEL, 'Restoring main webview state', {
    data: { executeImmediately },
  });

  try {
    // Focus the webview panel first to make sure it's visible
    await vscode.commands.executeCommand('texra.mainView.focus');

    const webviewView = await getMainWebview(CHANNEL);
    if (webviewView) {
      webviewView.webview.postMessage({
        command: 'restoreState',
        state,
        executeImmediately,
      });
      logger.info(CHANNEL, 'State restored via direct webview access');
      return;
    }

    // Store the state in memory for the MainViewProvider to pick up
    setPendingState(state, executeImmediately);
    await vscode.commands.executeCommand('texra.mainView.focus');
    logger.info(CHANNEL, 'State stored for later restoration', {
      data: { executeImmediately },
    });
  } catch (error) {
    await showLoggedErrorMessage(CHANNEL, 'Failed to restore state', error);
  }
}

export const stateRestoreCommand = {
  restoreState,
};
