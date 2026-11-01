// Third-party imports
import { Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports
import { withLogChannel } from '@texra-ai/harness/host';
import {
  ensureError,
  formatError,
  toErrorMessage,
} from '@texra-ai/harness/schemas';
import { openGuidePage } from '@frontend/hosts/VscodeExternalOpener';
import { vscodeUi } from '@frontend/hosts/VscodeUiHost';
import { ToolMissing } from '@texra/utils/system/toolChecks';

/** Valid documentation identifiers for error messages. */
type DocId = 'custom-agents' | 'latex-diff';

/**
 * Present a notice and keep these helpers' own failure channel empty.
 *
 * Their contract is "log this line and tell the user"; VS Code's message
 * machinery refusing the toast is a fault worth its own log line, not a
 * reason for every call site to grow an error arm for something it could
 * only log anyway.
 */
export function announce<A>(
  channel: string,
  notice: Effect.Effect<A, { readonly message: string }>,
  whenRefused: A,
): Effect.Effect<A> {
  return notice.pipe(
    Effect.catch((failure) =>
      Effect.logError(
        `Could not show the notification: ${failure.message}`,
      ).pipe(withLogChannel(channel), Effect.as(whenRefused)),
    ),
  );
}

const INSTALL_GUIDE_ACTION = 'View Installation Guide';

/**
 * Log a formatted error message and display it to the user. A missing tool's
 * message carries its install steps, and the notice offers the installation
 * guide: this is where the editor shows every `ToolMissing`.
 */
export function showLoggedErrorMessage(
  channel: string,
  prefix: string,
  err: unknown,
): Effect.Effect<string> {
  const message = formatError(prefix, err);
  if (!(err instanceof ToolMissing)) return showLoggedMessage(channel, message);
  return Effect.gen(function* () {
    yield* Effect.logError(message).pipe(withLogChannel(channel));
    const choice = yield* announce(
      channel,
      vscodeUi.error(message, { items: [INSTALL_GUIDE_ACTION] }),
      undefined,
    );
    if (choice === INSTALL_GUIDE_ACTION)
      yield* openGuidePage('installation').pipe(
        Effect.catch((error) =>
          Effect.logError('Could not open the installation guide', error).pipe(
            withLogChannel(channel),
          ),
        ),
      );
    return message;
  });
}

/** Log a pre-formatted message and display it to the user as an error. */
export function showLoggedMessage(
  channel: string,
  message: string,
): Effect.Effect<string> {
  return Effect.gen(function* () {
    yield* Effect.logError(message).pipe(withLogChannel(channel));
    yield* announce(channel, vscodeUi.showErrorMessage(message), undefined);
    return message;
  });
}

/** Log a message and display it to the user as an information notification. */
export function showLoggedInfoMessage(
  channel: string,
  message: string,
): Effect.Effect<string> {
  return Effect.gen(function* () {
    yield* Effect.logInfo(message).pipe(withLogChannel(channel));
    yield* announce(channel, vscodeUi.showInfoMessage(message), undefined);
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
    yield* Effect.logError(message).pipe(withLogChannel(channel));
    const selection = yield* announce(
      channel,
      vscodeUi.error(message, { items: [actionLabel] }),
      undefined,
    );
    if (selection !== actionLabel) return;

    yield* Effect.tryPromise({
      try: async () => {
        await vscode.commands.executeCommand('texra.openDoc', docId);
      },
      catch: ensureError,
    }).pipe(
      Effect.catch((err) =>
        Effect.logError(
          `Failed to open documentation: ${toErrorMessage(err)}`,
        ).pipe(withLogChannel(channel)),
      ),
    );
  });
}
