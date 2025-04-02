// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '../logger/logUtils';
import { objectToTaskState } from '../utils/configConversion';

const CHANNEL = 'stateRestoreCommand';
logger.initialize(CHANNEL);

/**
 * Register state restore command with VS Code
 */
export function registerStateRestoreCommand(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('coauthor.restoreState', restoreState),
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
    await vscode.commands.executeCommand('coauthor.mainView.focus');

    // Create a complete state object from the task state using utility function
    const taskState = objectToTaskState(config);
    const stateToRestore = {
      ...taskState,
      // Ensure we keep toolConfig as a proper object for the UI
      toolConfig: {
        autoExtractFigure: taskState.autoExtractFigure,
        autoExtractTikzFigure: taskState.autoExtractTikzFigure,
        attachTeXCount: taskState.attachTeXCount,
        usePrefillFromInput: taskState.usePrefillFromInput,
        printInputPrompt: taskState.printInputPrompt,
        reflect: taskState.reflect,
      },
    };

    // Try to get the webview directly using our safe command
    try {
      const webviewView =
        await vscode.commands.executeCommand<vscode.WebviewView>(
          'coauthor.getWebviewView',
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
          'coauthor.hasStateToRestore',
          true,
        );
        await vscode.commands.executeCommand(
          'setContext',
          'coauthor.stateToRestore',
          JSON.stringify(stateToRestore),
        );

        // Try to focus the main view to trigger its activation
        // Use the specific view ID to avoid sidebar switching issues
        await vscode.commands.executeCommand('coauthor.mainView.focus');
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
        'coauthor.hasStateToRestore',
        true,
      );
      await vscode.commands.executeCommand(
        'setContext',
        'coauthor.stateToRestore',
        JSON.stringify(stateToRestore),
      );

      // Try to focus the main view to trigger its activation
      // Use the specific view ID to avoid sidebar switching issues
      await vscode.commands.executeCommand('coauthor.mainView.focus');
      logger.info(CHANNEL, 'State stored in context for later restoration');
    }

    logger.info(CHANNEL, 'Main webview state restoration requested');
    // vscode.window.showInformationMessage('Configuration restored to main view');
  } catch (error) {
    logger.error(
      CHANNEL,
      `Error restoring main webview state: ${error instanceof Error ? error.message : String(error)}`,
    );
    vscode.window.showErrorMessage(
      `Failed to restore state: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export const stateRestoreCommand = {
  restoreState,
};
