// Third-party imports
import { z } from 'zod';
import * as vscode from 'vscode';

// Local imports
import { registerCommandEntries } from '@commands/_shared/registerCommands';
import { setPendingState } from '@common/state';
import {
  buildMainViewState,
  RestoreRunConfigInputSchema,
} from '@controllers/mainView/MainViewStateRestoreController';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import * as logger from '@logger/logUtils';

const CHANNEL = 'stateRestoreCommand';

const RESTORE_MALFORMED_MESSAGE =
  'Cannot restore state: persisted task data is malformed or from an incompatible version';

export function registerStateRestoreCommand(
  context: vscode.ExtensionContext,
): void {
  registerCommandEntries(context, [
    { id: 'texra.restoreState', handler: restoreState },
  ]);
}

async function restoreState(
  state: unknown,
  executeImmediately?: boolean,
): Promise<boolean> {
  logger.debug(CHANNEL, 'Restoring main webview state', {
    data: { executeImmediately },
  });

  const parsed = RestoreRunConfigInputSchema.safeParse(state);
  if (!parsed.success) {
    logger.info(CHANNEL, RESTORE_MALFORMED_MESSAGE, {
      data: { validationError: z.prettifyError(parsed.error) },
    });
    await vscode.window.showErrorMessage(RESTORE_MALFORMED_MESSAGE);
    return false;
  }

  try {
    const nextState = buildMainViewState(parsed.data);

    // The MainViewProvider is the sole deliverer of pending restores: it flushes
    // the queue on reveal and whenever the launcher is shown, so there is no
    // need to probe for a live webview here or to invoke showMainView twice.
    setPendingState(nextState, executeImmediately);
    await vscode.commands.executeCommand('texra.showMainView');
    logger.info(CHANNEL, 'State stored for restoration', {
      data: { executeImmediately },
    });
    return true;
  } catch (error) {
    await showLoggedErrorMessage(CHANNEL, 'Failed to restore state', error);
    return false;
  }
}
