// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { setPendingState } from '@common/state';
import { COMMON_COMMANDS } from '@common/webview/commands';
import { buildMainViewState } from '@frontend/mainViewStateUtils';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import { getMainWebview } from '@frontend/system/commandUtils';
import * as logger from '@logger/logUtils';
import { TaskStateSchema, type TaskState } from '@logger/TaskState';

const CHANNEL = 'stateRestoreCommand';
logger.initialize(CHANNEL);

const RESTORE_MALFORMED_MESSAGE =
  'Cannot restore state: persisted task data is malformed or from an incompatible version';

export function registerStateRestoreCommand(
  context: vscode.ExtensionContext,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('texra.restoreState', restoreState),
  );
}

async function restoreState(
  state: unknown,
  executeImmediately?: boolean,
): Promise<void> {
  logger.debug(CHANNEL, 'Restoring main webview state', {
    data: { executeImmediately },
  });

  const parsed = TaskStateSchema.safeParse(state);
  if (!parsed.success) {
    logger.info(CHANNEL, RESTORE_MALFORMED_MESSAGE, {
      data: { validationError: parsed.error.message },
    });
    await vscode.window.showErrorMessage(RESTORE_MALFORMED_MESSAGE);
    return;
  }

  try {
    const nextState = buildMainViewState(parsed.data as TaskState);

    await vscode.commands.executeCommand('texra.showMainView');

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

    setPendingState(nextState, executeImmediately);
    await vscode.commands.executeCommand('texra.showMainView');
    logger.info(CHANNEL, 'State stored for later restoration', {
      data: { executeImmediately },
    });
  } catch (error) {
    await showLoggedErrorMessage(CHANNEL, 'Failed to restore state', error);
  }
}
