// Third-party imports
import { Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import { ensureError } from '@utils/errors/errorMessage';

const DEFAULT_CHANNEL = 'commandUtils';

/** Execute a VS Code command, reporting a rejection once and answering
 *  `undefined` in its place. */
export function safeExecuteCommand<T>(
  command: string,
  args: unknown[] = [],
  channel: string = DEFAULT_CHANNEL,
): Effect.Effect<T | undefined> {
  return Effect.tryPromise({
    try: async () => vscode.commands.executeCommand<T>(command, ...args),
    catch: ensureError,
  }).pipe(
    Effect.catch((err) =>
      showLoggedErrorMessage(
        channel,
        `Error executing command ${command}`,
        err,
      ).pipe(Effect.as(undefined)),
    ),
  );
}
