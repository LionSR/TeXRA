// Third-party imports
import * as vscode from 'vscode';

// Local imports - shared schemas
import { MainViewPersistedStateSchema } from '@shared/schemas/mainViewState';

// Local imports - common
import { showLoggedErrorMessage, toErrorMessage } from '@common/errors';
import {
  buildMainViewStateFromTaskState,
  setPendingState,
} from '@common/state';
import { COMMON_COMMANDS } from '@common/webview/commands';

// Local imports - frontend
import { getMainWebview } from '@frontend/system/commandUtils';

// Local imports - logger
import * as logger from '@logger/logUtils';
import { TaskStateSchema, type TaskState } from '@logger/TaskState';
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
    const parsedTaskState = TaskStateSchema.safeParse(state);
    if (!parsedTaskState.success) {
      throw new Error('Invalid task state provided for restoration.');
    }
    const restoredState = buildMainViewStateFromTaskState(state);
    const validatedState = MainViewPersistedStateSchema.parse(restoredState);

    // Focus the webview panel first to make sure it's visible
    await vscode.commands.executeCommand('texra.mainView.focus');

    const webviewView = await getMainWebview(CHANNEL);
    if (webviewView) {
      webviewView.webview.postMessage({
        command: COMMON_COMMANDS.STATE_RESTORE,
        state: validatedState,
        executeImmediately,
      });
      logger.info(CHANNEL, 'State restored via direct webview access');
      return;
    }

    // Store the state in memory for the MainViewProvider to pick up
    setPendingState(validatedState, executeImmediately);
    await vscode.commands.executeCommand('texra.mainView.focus');
    logger.info(CHANNEL, 'State stored for later restoration', {
      data: { executeImmediately },
    });
  } catch (error) {
    await showLoggedErrorMessage(CHANNEL, 'Failed to restore state', error);
  }
}
