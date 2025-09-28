// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '@logger/logUtils';
import { objectToTaskState } from '@utils/config';
import { showLoggedErrorMessage } from '@common/errors/errorHandlingUtils';

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
    // Focus the webview panel first to make sure it's visible
    // Use the specific view ID instead of the extension to avoid sidebar switching issues
    await vscode.commands.executeCommand('texra.mainView.focus');

    // Create a complete state object from the task state using utility function
    const taskState = objectToTaskState(config);
    // TaskState already has toolConfig as a nested object
    const stateToRestore = taskState;

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
          state: stateToRestore,
        });

        logger.info(CHANNEL, 'State restored using direct webview access');
      } else {
        // Fallback to context storage method
        await vscode.commands.executeCommand(
          'setContext',
          'texra.hasStateToRestore',
          true,
        );
        await vscode.commands.executeCommand(
          'setContext',
          'texra.stateToRestore',
          stateToRestore,
        );

        // Try to focus the main view to trigger its activation
        // Use the specific view ID to avoid sidebar switching issues
        await vscode.commands.executeCommand('texra.mainView.focus');
        logger.info(CHANNEL, 'State stored in context for later restoration');
      }
    } catch (error) {
      logger.warn(
        CHANNEL,
        `Could not access webview directly: ${error instanceof Error ? error.message : String(error)}`,
      );

      // Fallback to context storage method
      await vscode.commands.executeCommand(
        'setContext',
        'texra.hasStateToRestore',
        true,
      );
      await vscode.commands.executeCommand(
        'setContext',
        'texra.stateToRestore',
        stateToRestore,
      );

      // Try to focus the main view to trigger its activation
      // Use the specific view ID to avoid sidebar switching issues
      await vscode.commands.executeCommand('texra.mainView.focus');
      logger.info(CHANNEL, 'State stored in context for later restoration');
    }

    logger.info(CHANNEL, 'Main webview state restoration requested');
    // vscode.window.showInformationMessage('Configuration restored to main view');
  } catch (error) {
    await showLoggedErrorMessage(CHANNEL, 'Failed to restore state', error);
  }
}

export const stateRestoreCommand = {
  restoreState,
};
