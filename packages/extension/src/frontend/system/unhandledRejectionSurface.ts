/**
 * The last-resort surface for a promise rejection in this extension that
 * nothing owned: log it, tell the user, then rethrow so the host still takes
 * Node's fatal path.
 */
// Third-party imports
import { Effect, Queue } from 'effect';
import * as vscode from 'vscode';

// Local imports
import { formatFatalErrorDetail, withLogChannel } from '@texra-ai/harness/host';
import { effectDiagnosticsLayer } from '@texra-ai/harness/node';
import { ensureError } from '@texra-ai/harness/schemas';

/** The extension entry's own channel. */
const CHANNEL = 'extension';

/**
 * Install the listener for the activation's scope. A process listener fires
 * outside any fiber, so it hands each entry to a fiber of that scope, which
 * logs it with the diagnostics the runtime would serve (the runtime may not
 * exist yet). The listener is acquired after the fork, so it is removed
 * before the fiber is interrupted.
 *
 * VS Code runs every extension in one host process, so the listener hears
 * their rejections too. It acts only on an error whose stack enters
 * `extensionPath`, this extension's install directory; any other is another
 * extension's, which the host logs itself.
 */
export const installUnhandledRejectionSurface = Effect.fn(
  'installUnhandledRejectionSurface',
)(function* (extensionPath: string) {
  const entries = yield* Queue.unbounded<{
    readonly message: string;
    readonly data: unknown;
  }>();
  yield* Effect.forkScoped(
    Effect.forever(
      Queue.take(entries).pipe(
        Effect.flatMap(({ message, data }) =>
          Effect.logError(message).pipe(Effect.annotateLogs({ data })),
        ),
      ),
    ).pipe(
      withLogChannel(CHANNEL),
      Effect.provide(effectDiagnosticsLayer('Trace')),
    ),
  );
  const logError = (message: string, data: unknown): void => {
    Queue.offerUnsafe(entries, { message, data });
  };
  const report = (error: unknown) => {
    if (!(error instanceof Error && error.stack?.includes(extensionPath))) {
      return;
    }
    logError('Unhandled extension-host rejection', error);
    void vscode.window
      .showErrorMessage(
        `TeXRA encountered an unrecoverable error: ${formatFatalErrorDetail(error)}`,
      )
      .then(undefined, (notificationError: unknown) => {
        logError(
          'Failed to display unhandled rejection error',
          notificationError,
        );
      });
    // Installing an unhandled-rejection listener otherwise suppresses Node's
    // default fatal path. The host must not continue after an unowned failure.
    setImmediate(() => {
      throw ensureError(error);
    });
  };
  yield* Effect.acquireRelease(
    Effect.sync(() => process.on('unhandledRejection', report)),
    () => Effect.sync(() => process.off('unhandledRejection', report)),
  );
});
