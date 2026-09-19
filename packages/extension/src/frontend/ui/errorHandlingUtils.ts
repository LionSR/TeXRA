// Third-party imports
import { Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports
import { formatError } from '@common/errors';
import { VscodeUiHost } from '@frontend/hosts/VscodeUiHost';
import { createLog, type Log } from '@logger/logUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';

/** Valid documentation identifiers for error messages. */
type DocId = 'intelligent-merge' | 'custom-agents' | 'latex-diff';

const ui = new VscodeUiHost();

/**
 * Present a notice and keep these helpers' own failure channel empty.
 *
 * Their contract is "log this line and tell the user"; VS Code's message
 * machinery refusing the toast is a fault worth its own log line, not a
 * reason for every call site to grow an error arm for something it could
 * only log anyway.
 */
function announce<A>(
  log: Log,
  notice: Effect.Effect<A, { readonly message: string }>,
  whenRefused: A,
): Effect.Effect<A> {
  return notice.pipe(
    Effect.catch((failure) =>
      Effect.sync(() => {
        log.error(`Could not show the notification: ${failure.message}`);
        return whenRefused;
      }),
    ),
  );
}

/** Log a formatted error message and display it to the user. */
export function showLoggedErrorMessage(
  channel: string,
  prefix: string,
  err: unknown,
): Effect.Effect<string> {
  return Effect.gen(function* () {
    const log = createLog(channel);
    const message = formatError(prefix, err);
    log.error(message);
    yield* announce(log, ui.showErrorMessage(message), undefined);
    return message;
  });
}

/** Log a pre-formatted message and display it to the user as an error. */
export function showLoggedMessage(
  channel: string,
  message: string,
): Effect.Effect<string> {
  return Effect.gen(function* () {
    const log = createLog(channel);
    log.error(message);
    yield* announce(log, ui.showErrorMessage(message), undefined);
    return message;
  });
}

/** Log a message and display it to the user as an information notification. */
export function showLoggedInfoMessage(
  channel: string,
  message: string,
): Effect.Effect<string> {
  return Effect.gen(function* () {
    const log = createLog(channel);
    log.info(message);
    yield* announce(log, ui.showInfoMessage(message), undefined);
    return message;
  });
}

/** Log an error message, display it with a docs action, and open the docs if selected. */
export function showLoggedMessageWithDocs(
  channel: string,
  message: string,
  docId: DocId,
  actionLabel = 'View Docs',
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const log = createLog(channel);
    log.error(message);
    const selection = yield* announce(
      log,
      ui.error(message, { items: [actionLabel] }),
      undefined,
    );
    if (selection !== actionLabel) return;

    yield* Effect.tryPromise({
      try: async () => {
        await vscode.commands.executeCommand('texra.openDoc', docId);
      },
      catch: (err: unknown) => err,
    }).pipe(
      Effect.catch((err) =>
        Effect.sync(() => {
          log.error(`Failed to open documentation: ${toErrorMessage(err)}`);
        }),
      ),
    );
  });
}
