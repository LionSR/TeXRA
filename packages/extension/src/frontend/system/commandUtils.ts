// Third-party imports
import { Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports
import { vscodeUi } from '@frontend/hosts/VscodeUiHost';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import { withLogChannel } from '@logger/effectLog';
import type { ToolMissingHandler } from '@platform/interfaces';
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

/** The VS Code host's `ToolMissingReporter`: log and show the message, and run
 *  the tool's docs command (`command,arg,...`) when the user asks for it. */
export const vscodeToolMissingReporter: ToolMissingHandler = (
  message,
  openDocsCommand,
) => {
  const [command, ...args] = openDocsCommand?.split(',') ?? [];
  return Effect.logError(message).pipe(
    Effect.andThen(
      vscodeUi.error(message, {
        items: command ? ['View Installation Guide'] : [],
      }),
    ),
    Effect.flatMap((choice) =>
      choice && command
        ? Effect.asVoid(safeExecuteCommand(command, args))
        : Effect.void,
    ),
    Effect.catch((error) =>
      Effect.logError('Tool-missing notice failed', error),
    ),
    withLogChannel(DEFAULT_CHANNEL),
  );
};
