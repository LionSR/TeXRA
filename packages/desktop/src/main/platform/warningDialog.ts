import { Effect } from 'effect';
import { BrowserWindow, dialog, type MessageBoxOptions } from 'electron';
import { ensureError } from '@texra-ai/harness/schemas';

/**
 * Show a startup-degradation warning: secret storage that is not encrypted,
 * transcripts that could not be persisted. Usable before any window exists,
 * so a failure during platform init is still visible. Finishes when the user
 * dismisses it.
 */
export const showDesktopWarningDialog = (
  message: string,
): Effect.Effect<void, Error> =>
  Effect.tryPromise({
    try: () => {
      const options: MessageBoxOptions = { message, type: 'warning' };
      const parentWindow =
        BrowserWindow.getFocusedWindow() ??
        BrowserWindow.getAllWindows().find((window) => !window.isDestroyed());
      return parentWindow == null
        ? dialog.showMessageBox(options)
        : dialog.showMessageBox(parentWindow, options);
    },
    catch: ensureError,
  }).pipe(Effect.asVoid);
