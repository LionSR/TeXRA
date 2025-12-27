// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import { showLoggedErrorMessage, toErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';
import type { TaskState } from '@logger/TaskState';
import { setPendingState } from '@common/state';
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
  return { restoreState };
}

/**
 * Restore the main webview state with configuration from a log tab
 */
async function restoreState(state: TaskState) {
  logger.debug(CHANNEL, 'Restoring main webview state');

  try {
    // Focus the webview panel first to make sure it's visible
    // Use the specific view ID instead of the extension to avoid sidebar switching issues
    await vscode.commands.executeCommand('texra.mainView.focus');

    // Try to get the webview directly using our safe command
    try {
      const webviewView =
        await vscode.commands.executeCommand<vscode.WebviewView>(
          'texra.getWebviewView',
        );

      if (webviewView) {
        // Send the state directly to the webview
        webviewView.webview.postMessage({
          command: 'restoreState',
          state,
        });

        logger.info(CHANNEL, 'State restored using direct webview access');
        logger.info(CHANNEL, 'Main webview state restoration requested');
        return;
      } else {
        await storeStateForLater(state);
      }
    } catch (error) {
      logger.warn(
        CHANNEL,
        `Could not access webview directly: ${toErrorMessage(error)}`,
      );

      await storeStateForLater(state);
    }

    logger.info(CHANNEL, 'Main webview state restoration requested');
  } catch (error) {
    await showLoggedErrorMessage(CHANNEL, 'Failed to restore state', error);
  }
}

export const stateRestoreCommand = {
  restoreState,
};

async function storeStateForLater(state: TaskState): Promise<void> {
  // Store the state in memory for the MainViewProvider to pick up
  setPendingState(state);
  await vscode.commands.executeCommand('texra.mainView.focus');
  logger.info(CHANNEL, 'State stored for later restoration');
}
