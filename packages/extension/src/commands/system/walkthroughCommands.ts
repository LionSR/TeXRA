// Third-party imports
import { Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports
import { ensureError } from '@utils/errors/errorMessage';

const GETTING_STARTED_WALKTHROUGH_ID = 'texra.gettingStarted';

export function openGettingStarted(extensionId: string) {
  return Effect.tryPromise({
    try: () =>
      vscode.commands.executeCommand(
        'workbench.action.openWalkthrough',
        `${extensionId}#${GETTING_STARTED_WALKTHROUGH_ID}`,
      ),
    catch: ensureError,
  }).pipe(Effect.asVoid);
}
