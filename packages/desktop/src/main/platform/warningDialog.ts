import { BrowserWindow, dialog, type MessageBoxOptions } from 'electron';

type BrowserWindowSelector = Pick<
  typeof BrowserWindow,
  'getAllWindows' | 'getFocusedWindow'
>;

export function getDesktopWarningParentWindow(
  browserWindow: BrowserWindowSelector = BrowserWindow,
): BrowserWindow | undefined {
  return (
    browserWindow.getFocusedWindow() ??
    browserWindow.getAllWindows().find((window) => !window.isDestroyed())
  );
}

/**
 * Show a startup-degradation warning: secret storage that is not encrypted,
 * transcripts that could not be persisted. Usable before any window exists,
 * so a failure during platform init is still visible.
 */
export async function showDesktopWarningDialog(message: string): Promise<void> {
  const options: MessageBoxOptions = { message, type: 'warning' };
  const parentWindow = getDesktopWarningParentWindow();
  if (parentWindow == null) {
    await dialog.showMessageBox(options);
    return;
  }

  await dialog.showMessageBox(parentWindow, options);
}
