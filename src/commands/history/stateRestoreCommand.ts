// Third-party imports
import * as vscode from 'vscode';

// Local imports - common
import { showLoggedErrorMessage } from '@common/errors';
import { setPendingState } from '@common/state';
import { buildMainViewState } from '@common/state/mainViewStateUtils';
import { COMMON_COMMANDS } from '@common/webview/commands';

// Local imports - frontend
import { getMainWebview } from '@frontend/system/commandUtils';

// Local imports - logging
import * as logger from '@logger/logUtils';

// Local imports - task state
import type { TaskState } from '@logger/TaskState';

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
