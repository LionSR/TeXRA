/**
 * The extension host's last-resort surface for a promise rejection nothing
 * owned: log it, tell the user, then rethrow so the host still takes Node's
 * fatal path.
 */
// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { writeLogLine } from '@logger/logSink';
import { formatFatalErrorDetail } from '@logger/redaction';
import { ensureError } from '@utils/errors/errorMessage';

/** The extension entry's own channel. */
const CHANNEL = 'extension';

export function installUnhandledRejectionSurface(
  subscriptions: vscode.Disposable[],
): void {
  // A process listener that may fire before the runtime exists or after it is
  // disposed, so it writes to the host sink directly rather than via a fiber.
  const logError = (message: string, data: unknown) =>
    writeLogLine('ERROR', CHANNEL, message, data);
  const report = (error: unknown) => {
    logError('Unhandled extension-host rejection', error);
    void vscode.window
      .showErrorMessage(
        `The extension host encountered an unrecoverable error: ${formatFatalErrorDetail(error)}`,
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
  process.on('unhandledRejection', report);
  subscriptions.push({
    dispose: () => process.off('unhandledRejection', report),
  });
}
