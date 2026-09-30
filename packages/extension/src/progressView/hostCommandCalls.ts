/**
 * How the extension's request arms reach a command: a VS Code command lifted
 * once through `fromHost`, or one of this extension's own command handlers run
 * in the arm's fiber. Either way the failure is named by the command and
 * logged before it travels on.
 */
import * as vscode from 'vscode';
import { Effect } from 'effect';

import {
  fromHost,
  hostFailure,
  type HostCallFailed,
} from '@controllers/session/hostCallFailure';
import { withLogChannel } from '@logger/effectLog';
import type { RequestRefusal } from '@shared/session/requestErrors';
import { toErrorMessage } from '@utils/errors/errorMessage';

const logCommandFailure =
  (command: string) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    Effect.tapError(self, (failure) =>
      Effect.logError(
        `Command ${command} failed: ${toErrorMessage(failure)}`,
      ).pipe(withLogChannel('HostCommandCalls')),
    );

/** A VS Code command lifted once through `fromHost`, named by the command,
 *  with its failure logged before it travels on. */
export function runCommand<T = void>(
  command: string,
  ...args: unknown[]
): Effect.Effect<T | undefined, HostCallFailed | RequestRefusal> {
  return fromHost(command, () =>
    vscode.commands.executeCommand<T | undefined>(command, ...args),
  ).pipe(logCommandFailure(command));
}

/** One of this extension's own command handlers, run in the arm's fiber
 *  rather than through `vscode.commands.executeCommand`: its failure is named
 *  and logged as a command's is. */
export function runHandler<A, E, R>(
  command: string,
  handler: Effect.Effect<A, E, R>,
): Effect.Effect<A, HostCallFailed | RequestRefusal, R> {
  return handler.pipe(
    Effect.mapError((cause) => hostFailure(command, cause)),
    logCommandFailure(command),
  );
}

/** A VS Code command as a verb of the shared binding table: lifted once,
 *  named, and with the command's own result discarded. */
export function commandVerb(command: string, ...args: unknown[]) {
  return Effect.asVoid(runCommand(command, ...args));
}
