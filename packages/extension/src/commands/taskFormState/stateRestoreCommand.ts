// Third-party imports
import { z } from 'zod';
import * as vscode from 'vscode';

// Local imports
import { registerCommandEntries } from '@commands/_shared/registerCommands';
import { setPendingState } from '@common/state/pendingStateManager';
import {
  buildMainViewState,
  RestoreRunConfigInputSchema,
} from '@controllers/mainView/MainViewStateRestoreController';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import { createLog } from '@logger/logUtils';

const CHANNEL = 'stateRestoreCommand';
const log = createLog(CHANNEL);

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
  log.debug('Restoring main webview state', {
    data: { executeImmediately },
  });

  const parsed = RestoreRunConfigInputSchema.safeParse(state);
  if (!parsed.success) {
    log.info(RESTORE_MALFORMED_MESSAGE, {
      data: { validationError: z.prettifyError(parsed.error) },
    });
    await vscode.window.showErrorMessage(RESTORE_MALFORMED_MESSAGE);
    return false;
  }

  try {
    const nextState = buildMainViewState(parsed.data);

    // The MainViewProvider is the sole deliverer of pending restores: it flushes
    // the queue only after the launcher document reports WEBVIEW_READY (or
    // immediately when that document is already ready), so there is no need to
    // probe for a live webview here or to invoke showMainView twice.
    setPendingState(nextState, executeImmediately);
    await vscode.commands.executeCommand('texra.showMainView');
    log.info('State stored for restoration', {
      data: { executeImmediately },
    });
    return true;
  } catch (error) {
    await showLoggedErrorMessage(CHANNEL, 'Failed to restore state', error);
    return false;
  }
}
