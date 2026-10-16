/**
 * The extension host's last-resort surface for a promise rejection nothing
 * owned: log it, tell the user, then rethrow so the host still takes Node's
 * fatal path.
 */
// Third-party imports
import { Effect, Queue } from 'effect';
import * as vscode from 'vscode';

// Local imports
import { formatFatalErrorDetail, withLogChannel } from '@texra-ai/harness';
import { effectDiagnosticsLayer } from '@logger/effectDiagnostics';
import { ensureError } from '@utils/errors/errorMessage';

/** The extension entry's own channel. */
const CHANNEL = 'extension';

/** One entry the process listener hands to the logging fiber. */
interface RejectionEntry {
  readonly message: string;
  readonly error: unknown;
  /** Rethrow once logged: the rejection itself, not a failure reporting it. */
  readonly fatal: boolean;
}

/**
 * Install the listener for the activation's scope. The listener fires outside
 * any fiber, so it hands each entry to a fiber of that scope, which logs it
 * with the diagnostics the runtime would serve (the runtime may not exist yet,
 * or may already be gone) and only then rethrows a fatal one.
 */
export const installUnhandledRejectionSurface = Effect.fn(
  'installUnhandledRejectionSurface',
)(function* (subscriptions: vscode.Disposable[]) {
  const entries = yield* Queue.unbounded<RejectionEntry>();
  yield* Effect.forkScoped(
    Effect.forever(
      Queue.take(entries).pipe(
        Effect.flatMap(({ message, error, fatal }) =>
          Effect.logError(message).pipe(
            Effect.annotateLogs({ data: error }),
            // Installing an unhandled-rejection listener otherwise suppresses
            // Node's default fatal path. The host must not continue after an
            // unowned failure.
            Effect.andThen(
              Effect.sync(() => {
                if (!fatal) return;
                setImmediate(() => {
                  throw ensureError(error);
                });
              }),
            ),
          ),
        ),
      ),
    ).pipe(
      withLogChannel(CHANNEL),
      Effect.provide(effectDiagnosticsLayer('Trace')),
    ),
  );
  const report = (error: unknown) => {
    Queue.offerUnsafe(entries, {
      message: 'Unhandled extension-host rejection',
      error,
      fatal: true,
    });
    void vscode.window
      .showErrorMessage(
        `The extension host encountered an unrecoverable error: ${formatFatalErrorDetail(error)}`,
      )
      .then(undefined, (notificationError: unknown) => {
        Queue.offerUnsafe(entries, {
          message: 'Failed to display unhandled rejection error',
          error: notificationError,
          fatal: false,
        });
      });
  };
  process.on('unhandledRejection', report);
  subscriptions.push({
    dispose: () => process.off('unhandledRejection', report),
  });
});
