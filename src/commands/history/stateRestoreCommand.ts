// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { showLoggedErrorMessage } from '@common/errors';
import { setPendingState, buildMainViewState } from '@common/state';
import { COMMON_COMMANDS } from '@common/webview/commands';
import { getMainWebview } from '@frontend/system/commandUtils';
import * as logger from '@logger/logUtils';
import type { TaskState } from '@logger/TaskState';

const CHANNEL = 'stateRestoreCommand';
logger.initialize(CHANNEL);

/**
 * Register state restore command with VS Code.
 */
export function registerStateRestoreCommand(
  context: vscode.ExtensionContext,
): void {
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
async function restoreState(
  state: TaskState,
  executeImmediately?: boolean,
): Promise<void> {
  logger.debug(CHANNEL, 'Restoring main webview state', {
    data: { executeImmediately },
  });

  try {
    const nextState = buildMainViewState(state);

    // Focus the webview panel first to make sure it's visible
    await vscode.commands.executeCommand('texra.mainView.focus');

    const webviewView = await getMainWebview(CHANNEL);
    if (webviewView) {
      webviewView.webview.postMessage({
        command: COMMON_COMMANDS.STATE_RESTORE,
        state: nextState,
        executeImmediately,
      });
      logger.info(CHANNEL, 'State restored via direct webview access');
      return;
    }

    // Store the state in memory for the MainViewProvider to pick up
    setPendingState(nextState, executeImmediately);
    await vscode.commands.executeCommand('texra.mainView.focus');
    logger.info(CHANNEL, 'State stored for later restoration', {
      data: { executeImmediately },
    });
  } catch (error) {
    await showLoggedErrorMessage(CHANNEL, 'Failed to restore state', error);
  }
}
