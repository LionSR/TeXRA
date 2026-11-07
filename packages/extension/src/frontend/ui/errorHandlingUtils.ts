// Third-party imports
import { Effect } from 'effect';

// Local imports
import { formatError, toErrorMessage } from '@texra-ai/harness/schemas';
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
 *
 * None of these helpers names a log channel: their lines take the channel
 * of the program that calls them (`withLogChannel` at its entry).
 */
export function announce<A>(
  notice: Effect.Effect<A, { readonly message: string }>,
  whenRefused: A,
): Effect.Effect<A> {
  return notice.pipe(
    Effect.catch((failure) =>
      Effect.logError(
        `Could not show the notification: ${failure.message}`,
      ).pipe(Effect.as(whenRefused)),
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
  prefix: string,
  err: unknown,
): Effect.Effect<string> {
  if (!(err instanceof ToolMissing))
    return showLoggedMessage(formatError(prefix, err));
  // Whole, not truncated as `formatError` would: the install steps are the
  // point of the notice.
  const message = `${prefix}: ${err.message}`;
  return Effect.gen(function* () {
    yield* Effect.logError(message);
    const choice = yield* announce(
      vscodeUi.ask('error', message, { items: [INSTALL_GUIDE_ACTION] }),
      undefined,
    );
    if (choice === INSTALL_GUIDE_ACTION)
      yield* openGuidePage('installation').pipe(
        Effect.catch((error) =>
          Effect.logError('Could not open the installation guide', error),
        ),
      );
    return message;
  });
}

// A notice with no action has nothing to answer, but VS Code finishes its
// promise only when the user dismisses it; the two helpers below show it on
// a fiber of its own, so the caller (a command an `executeCommand` caller
// awaits) does not wait for the dismissal.

/** Log a pre-formatted message and display it to the user as an error,
 *  without waiting for the notice to be dismissed. */
export const showLoggedMessage = Effect.fn('showLoggedMessage')(function* (
  message: string,
): Effect.fn.Return<string> {
  yield* Effect.logError(message);
  yield* Effect.forkDetach(vscodeUi.notify('error', message));
  return message;
});

/** Log a message and display it to the user as an information notification,
 *  without waiting for the notice to be dismissed. */
export const showLoggedInfoMessage = Effect.fn('showLoggedInfoMessage')(
  function* (message: string): Effect.fn.Return<string> {
    yield* Effect.logInfo(message);
    yield* Effect.forkDetach(vscodeUi.notify('info', message));
    return message;
  },
);

/** Log an error message, display it with a docs action, and open the docs if selected. */
export const showLoggedMessageWithDocs = Effect.fn('showLoggedMessageWithDocs')(
  function* (
    message: string,
    docId: DocId,
    actionLabel = 'View Docs',
  ): Effect.fn.Return<void> {
    yield* Effect.logError(message);
    const selection = yield* announce(
      vscodeUi.ask('error', message, { items: [actionLabel] }),
      undefined,
    );
    if (selection !== actionLabel) return;

    yield* openGuidePage(docId).pipe(
      Effect.catch((err) =>
        Effect.logError(`Failed to open documentation: ${toErrorMessage(err)}`),
      ),
    );
  },
);
